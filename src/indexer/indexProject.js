const fs = require('fs');
const path = require('path');
const { detectExports } = require('./detectExports');
const { detectPythonExports } = require('./detectPythonExports');
const { detectRunnable } = require('./detectRunnable');
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
  'vendor',
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'site-packages',
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
    const pyproject = getPyprojectMeta(rootDir);
    if (pyproject) return pyproject;
    return {
      name: path.basename(rootDir),
      version: '0.0.0',
    };
  }
}

function getPyprojectMeta(rootDir) {
  const pyprojectPath = path.join(rootDir, 'pyproject.toml');
  try {
    const raw = fs.readFileSync(pyprojectPath, 'utf8');
    const projectBlock = getTomlBlock(raw, 'project');
    const poetryBlock = getTomlBlock(raw, 'tool.poetry');
    const block = projectBlock || poetryBlock || raw;
    const nameMatch = block.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    const versionMatch = block.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
    return {
      name: nameMatch ? nameMatch[1] : path.basename(rootDir),
      version: versionMatch ? versionMatch[1] : '0.0.0',
    };
  } catch (err) {
    return null;
  }
}

function getTomlBlock(raw, sectionName) {
  const lines = String(raw || '').split(/\r?\n/);
  const out = [];
  let active = false;

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      if (active) break;
      active = sectionMatch[1] === sectionName;
      continue;
    }
    if (active) out.push(line);
  }

  return out.length ? out.join('\n') : null;
}

function getCallableManifest(rootDir) {
  const manifestPath = path.join(rootDir, 'mesh.exports.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.exports)) return [];
    return parsed.exports
      .filter((e) => e && typeof e.file === 'string' && typeof e.exportName === 'string')
      .map((e) => ({
        file: path.normalize(e.file),
        exportName: e.exportName,
      }));
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
    return [];
  }
}

function isCallableExport({ source, exportName, fileRelativePath, manifest }) {
  if (source && source.includes('@mesh callable')) return true;
  return manifest.some((entry) => {
    return entry.exportName === exportName && path.normalize(entry.file) === fileRelativePath;
  });
}

function getExecutionForEntry({ entryType, modulePath, exportName, rootDir, relativePath }) {
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
  if (entryType === 'python_function') {
    return {
      kind: 'python_import',
      modulePath,
      moduleName: getPythonModuleName(rootDir, modulePath),
      projectRoot: rootDir,
      exportName,
    };
  }
  return null;
}

function getPythonModuleName(rootDir, filePath) {
  const parsed = path.parse(filePath);
  const parts = parsed.name === '__init__' ? [] : [parsed.name];
  let dir = parsed.dir;

  while (dir && path.resolve(dir) !== path.resolve(rootDir)) {
    if (!fs.existsSync(path.join(dir, '__init__.py'))) {
      break;
    }
    parts.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }

  return parts.join('.');
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

  return { inputs, output };
}

function getInputOutputContract({ exp, entryType, docsByExport }) {
  const isFunctionLike = entryType === 'node_function' || entryType === 'python_function' || entryType === 'react_component' || entryType === 'react_hook';
  const docs = docsByExport.get(exp.exportName) || { inputs: [], output: null };
  if (!isFunctionLike) {
    const inferredValueOutput = exp.valueContract
      ? {
        type: exp.valueContract.type || 'unknown',
        description: '',
        ...(exp.valueContract.schema ? { schema: exp.valueContract.schema } : {}),
        ...(exp.valueContract.items ? { items: exp.valueContract.items } : {}),
      }
      : null;
    return {
      inputs: [],
      output: docs.output || inferredValueOutput || { type: 'unknown', description: '' },
    };
  }

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

async function indexProject({ rootDir = process.cwd(), outFile } = {}) {
  const ignoreSet = new Set(DEFAULT_IGNORES);
  const allFiles = await walkFiles(rootDir, ignoreSet);
  const manifest = getCallableManifest(rootDir);
  const packageRunnableMeta = getPackageRunnableMeta(rootDir);

  const entries = [];
  const counts = {
    total: 0,
    node_function: 0,
    python_function: 0,
    python_class: 0,
    cli_command: 0,
    react_component: 0,
    react_hook: 0,
    util: 0,
    unknown: 0,
    callable: 0,
  };

  for (const entry of packageRunnableMeta.entries) {
    entries.push(entry);
    counts.total += 1;
    counts.cli_command += 1;
    if (entry.callable) counts.callable += 1;
  }

  for (const filePath of allFiles) {
    const isPython = /\.py$/.test(filePath);
    const isJavaScript = /\.(js|cjs|mjs|jsx|tsx)$/.test(filePath);
    const relativePath = path.relative(rootDir, filePath);
    let source;
    if (isJavaScript || isPython) {
      try {
        source = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        continue;
      }
    }

    const runnable = detectRunnable({
      rootDir,
      filePath,
      source,
      packageBinFiles: packageRunnableMeta.binFiles,
    });
    if (runnable) {
      entries.push({
        id: hashId(`${relativePath}:cli`),
        filePath,
        relativePath,
        ...runnable,
      });
      counts.total += 1;
      counts.cli_command += 1;
      if (runnable.callable) counts.callable += 1;
    }

    if (!isJavaScript && !isPython) continue;

    const exports = isPython
      ? await detectPythonExports({ filePath, source })
      : detectExports({ filePath, source });
    const docsByExport = isPython ? new Map() : extractDocContracts(source);
    for (const exp of exports) {
      const reactType = isPython ? null : detectReactType({ exportName: exp.exportName, filePath, source });
      const entryType = isPython
        ? (exp.type === 'function' ? 'python_function' : (exp.type === 'class' ? 'python_class' : 'util'))
        : (reactType || (exp.type === 'function' ? 'node_function' : 'util'));
      const language = isPython ? 'python' : 'javascript';
      const runtime = isPython ? 'python' : (reactType ? 'browser' : 'node');
      const modulePath = filePath;
      const exportName = exp.exportName;
      const id = hashId(`${relativePath}:${exportName}`);
      const signature = exp.params && exp.params.length ? `(${exp.params.join(', ')})` : '';
      const callable = entryType === 'node_function' || entryType === 'python_function'
        ? isCallableExport({ source, exportName, fileRelativePath: relativePath, manifest })
        : false;

      entries.push({
        id,
        type: entryType,
        filePath,
        relativePath,
        exportName,
        signature,
        language,
        runtime,
        callable,
        io: getInputOutputContract({ exp, entryType, docsByExport }),
        execution: getExecutionForEntry({ entryType, modulePath, exportName, rootDir, relativePath }),
      });

      counts.total += 1;
      if (counts[entryType] !== undefined) counts[entryType] += 1;
      else counts.unknown += 1;
      if (callable) counts.callable += 1;
    }
  }

  const meta = getProjectMeta(rootDir);
  const index = {
    project: {
      name: meta.name,
      version: meta.version,
      rootPath: rootDir,
      createdAt: new Date().toISOString(),
    },
    summary: {
      totals: counts,
    },
    entries,
  };

  const outputPath = outFile || path.join(rootDir, '.leumas', 'functionIndex.json');
  await writeIndex({ outFile: outputPath, index });
  return index;
}

function getPackageRunnableMeta(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    return { entries: [], binFiles: new Set() };
  }

  const binFiles = new Set();
  if (typeof pkg.bin === 'string') {
    binFiles.add(normalizePackagePath(pkg.bin));
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) {
      if (typeof value === 'string') binFiles.add(normalizePackagePath(value));
    }
  }

  const entries = [];
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [scriptName, scriptCommand] of Object.entries(pkg.scripts)) {
      if (typeof scriptCommand !== 'string') continue;
      entries.push(createPackageScriptEntry({ rootDir, pkgPath, scriptName, scriptCommand }));
    }
  }

  return { entries, binFiles };
}

function createPackageScriptEntry({ rootDir, pkgPath, scriptName, scriptCommand }) {
  const command = 'npm';
  const args = ['--prefix', rootDir, 'run', scriptName];
  return {
    id: hashId(`package.json:npm:${scriptName}`),
    type: 'cli_command',
    filePath: pkgPath,
    relativePath: 'package.json',
    exportName: `npm:${scriptName}`,
    signature: '[...args]',
    language: 'package_script',
    runtime: 'npm_script',
    callable: true,
    io: {
      inputs: [
        {
          name: 'args',
          type: 'array',
          required: false,
          description: 'Arguments passed to the npm script after --.',
          items: { type: 'string' },
        },
      ],
      output: {
        type: 'process_result',
        description: 'Exit code, stdout, and stderr from the script process.',
      },
    },
    execution: {
      kind: 'cli',
      filePath: pkgPath,
      command,
      args,
      appendArgsSeparator: '--',
      callCommand: `${command} --prefix ${quoteCommandArg(rootDir)} run ${quoteCommandArg(scriptName)}`,
      usageCommand: `${command} --prefix ${quoteCommandArg(rootDir)} run ${quoteCommandArg(scriptName)} -- [...args]`,
      cwd: rootDir,
      platform: 'cross-platform',
      runtime: 'npm_script',
      packageScript: scriptName,
      scriptCommand,
    },
  };
}

function normalizePackagePath(value) {
  return path.normalize(String(value || '').replace(/^\.\//, ''));
}

function quoteCommandArg(value) {
  const raw = String(value || '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(raw)) return raw;
  return `"${raw.replace(/(["\\$`])/g, '\\$1')}"`;
}

module.exports = { indexProject };
