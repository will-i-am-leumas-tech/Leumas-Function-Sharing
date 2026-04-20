const fs = require('fs');
const path = require('path');
const { detectExports } = require('./detectExports');
const { detectReactType } = require('./detectReact');
const { writeIndex } = require('./writeIndex');
const { hashId } = require('../shared/hashId');

const DEFAULT_IGNORES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.leumas',
  'coverage',
]);

async function walkFiles(rootDir, ignoreSet) {
  const out = [];
  const queue = [rootDir];

  while (queue.length) {
    const dir = queue.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreSet.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }
      if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }

  return out;
}

function getProjectMeta(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return {
      name: pkg.name || path.basename(rootDir),
      version: pkg.version || '0.0.0',
    };
  } catch (err) {
    return {
      name: path.basename(rootDir),
      version: '0.0.0',
    };
  }
}

function getCallableManifest(rootDir) {
  const manifestPath = path.join(rootDir, 'mesh.exports.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.exports)) return [];
    return parsed.exports
      .filter((entry) => entry && typeof entry.file === 'string' && typeof entry.exportName === 'string')
      .map((entry) => ({
        file: path.normalize(entry.file),
        exportName: entry.exportName,
      }));
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
    return [];
  }
}

function isCallableExport({ source, exportName, fileRelativePath, manifest }) {
  if (source && source.includes('@mesh callable')) return true;
  return manifest.some((entry) => entry.exportName === exportName && path.normalize(entry.file) === fileRelativePath);
}

function getExecutionForEntry({ entryType, modulePath, exportName }) {
  if (entryType === 'node_function') {
    return {
      kind: 'import',
      modulePath,
      exportName,
    };
  }
  if (entryType === 'react_component' || entryType === 'react_hook') {
    return {
      kind: 'module',
      modulePath,
      exportName,
    };
  }
  return null;
}

function extractDocContracts(source) {
  const out = new Map();
  const patterns = [
    /\/\*\*([\s\S]*?)\*\/\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /\/\*\*([\s\S]*?)\*\/\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/g,
    /\/\*\*([\s\S]*?)\*\/\s*export\s+default\s+function\s*([A-Za-z0-9_]*)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const rawBlock = match[1];
      const exportName = match[2] || 'default';
      out.set(exportName, parseDocBlock(rawBlock));
    }
  }

  return out;
}

function parseDocBlock(rawBlock) {
  const lines = String(rawBlock || '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean);

  const inputs = [];
  let output = null;

  for (const line of lines) {
    const paramMatch = line.match(/^@param\s+\{([^}]+)\}\s+(\[[^\]]+\]|[A-Za-z0-9_$.]+)\s*(.*)$/);
    if (paramMatch) {
      const rawName = paramMatch[2].trim();
      const optional = rawName.startsWith('[') && rawName.endsWith(']');
      const cleanName = optional ? rawName.slice(1, -1).split('=')[0] : rawName;
      inputs.push({
        name: cleanName,
        type: paramMatch[1].trim(),
        required: !optional,
        description: paramMatch[3] ? paramMatch[3].trim() : '',
      });
      continue;
    }

    const returnMatch = line.match(/^@returns?\s+\{([^}]+)\}\s*(.*)$/);
    if (returnMatch) {
      output = {
        type: returnMatch[1].trim(),
        description: returnMatch[2] ? returnMatch[2].trim() : '',
      };
    }
  }

  return {
    inputs,
    output,
  };
}

function getInputOutputContract({ exp, entryType, docsByExport }) {
  const isFunctionLike = entryType === 'node_function' || entryType === 'react_component' || entryType === 'react_hook';
  if (!isFunctionLike) {
    return {
      inputs: [],
      output: { type: 'unknown', description: '' },
    };
  }

  const docs = docsByExport.get(exp.exportName) || { inputs: [], output: null };
  const docInputsByName = new Map(docs.inputs.map((item) => [item.name, item]));
  const inferredInputs = Array.isArray(exp.paramContracts)
    ? exp.paramContracts.map((item) => ({
      name: item.name,
      type: item.type || 'unknown',
      required: item.required !== false,
      description: item.description || '',
      ...(item.schema ? { schema: item.schema } : {}),
      ...(item.items ? { items: item.items } : {}),
    }))
    : [];
  const params = Array.isArray(exp.params) ? exp.params : [];
  const fallbackInputs = inferredInputs.length
    ? inferredInputs
    : params.map((name) => ({
      name,
      type: 'unknown',
      required: true,
      description: '',
    }));

  const inputs = fallbackInputs.map((item) => docInputsByName.get(item.name) || item);
  for (const docInput of docs.inputs) {
    if (!inputs.some((item) => item.name === docInput.name)) {
      inputs.push(docInput);
    }
  }

  const inferredOutput = exp.returnContract
    ? {
      type: exp.returnContract.type || 'unknown',
      description: exp.returnContract.description || '',
      ...(exp.returnContract.schema ? { schema: exp.returnContract.schema } : {}),
      ...(exp.returnContract.items ? { items: exp.returnContract.items } : {}),
    }
    : null;

  return {
    inputs,
    output: docs.output || inferredOutput || { type: 'unknown', description: '' },
  };
}

async function indexProject({ rootDir, outFile } = {}) {
  const targetRoot = path.resolve(rootDir || process.cwd());
  const ignoreSet = new Set(DEFAULT_IGNORES);
  const allFiles = await walkFiles(targetRoot, ignoreSet);
  const manifest = getCallableManifest(targetRoot);

  const entries = [];
  const counts = {
    total: 0,
    node_function: 0,
    react_component: 0,
    react_hook: 0,
    util: 0,
    unknown: 0,
    callable: 0,
  };

  for (const filePath of allFiles) {
    if (!/\.(js|cjs|mjs|jsx|tsx)$/.test(filePath)) continue;
    const relativePath = path.relative(targetRoot, filePath);
    let source;
    try {
      source = await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      continue;
    }

    const exports = detectExports({ filePath, source });
    const docsByExport = extractDocContracts(source);
    for (const exp of exports) {
      const reactType = detectReactType({ exportName: exp.exportName, filePath, source });
      const entryType = reactType || (exp.type === 'function' ? 'node_function' : 'util');
      const runtime = reactType ? 'browser' : 'node';
      const exportName = exp.exportName;
      const id = hashId(`${relativePath}:${exportName}`);
      const signature = exp.params && exp.params.length ? `(${exp.params.join(', ')})` : '';
      const callable = entryType === 'node_function'
        ? isCallableExport({ source, exportName, fileRelativePath: relativePath, manifest })
        : false;

      entries.push({
        id,
        type: entryType,
        filePath,
        relativePath,
        exportName,
        signature,
        runtime,
        callable,
        io: getInputOutputContract({ exp, entryType, docsByExport }),
        execution: getExecutionForEntry({ entryType, modulePath: filePath, exportName }),
      });

      counts.total += 1;
      if (counts[entryType] !== undefined) counts[entryType] += 1;
      else counts.unknown += 1;
      if (callable) counts.callable += 1;
    }
  }

  const meta = getProjectMeta(targetRoot);
  const index = {
    project: {
      name: meta.name,
      version: meta.version,
      rootPath: targetRoot,
      createdAt: new Date().toISOString(),
    },
    summary: {
      totals: counts,
    },
    entries,
  };

  const outputPath = outFile || path.join(targetRoot, '.leumas', 'functionIndex.json');
  await writeIndex({ outFile: outputPath, index });
  return {
    outputPath,
    index,
  };
}

module.exports = { indexProject };
