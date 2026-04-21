const fs = require('fs');
const path = require('path');

const ENTRY_FIELDS = ['main', 'module', 'browser'];
const DEFAULT_ENTRY_FILES = ['index.js', 'index.mjs', 'index.cjs', path.join('src', 'index.js'), path.join('src', 'index.mjs'), path.join('src', 'index.cjs')];

function detectSdkEntrypoints({ rootDir, allFiles = [] } = {}) {
  const packagePaths = allFiles
    .filter((filePath) => path.basename(filePath) === 'package.json')
    .sort((a, b) => path.relative(rootDir, a).localeCompare(path.relative(rootDir, b)));
  const byFile = new Map();

  for (const pkgPath of packagePaths) {
    const pkg = readPackage(pkgPath);
    if (!pkg) continue;
    const packageDir = path.dirname(pkgPath);
    const packageName = pkg.name || path.basename(packageDir);

    for (const field of ENTRY_FIELDS) {
      if (typeof pkg[field] !== 'string') continue;
      addCandidate(byFile, {
        rootDir,
        packageDir,
        packageName,
        field,
        filePath: path.resolve(packageDir, pkg[field]),
      });
    }

    for (const exportedPath of extractExportsPaths(pkg.exports)) {
      addCandidate(byFile, {
        rootDir,
        packageDir,
        packageName,
        field: 'exports',
        filePath: path.resolve(packageDir, exportedPath),
      });
    }

    for (const defaultEntry of DEFAULT_ENTRY_FILES) {
      addCandidate(byFile, {
        rootDir,
        packageDir,
        packageName,
        field: 'default',
        filePath: path.resolve(packageDir, defaultEntry),
      });
    }
  }

  if (!packagePaths.length) {
    for (const defaultEntry of DEFAULT_ENTRY_FILES) {
      addCandidate(byFile, {
        rootDir,
        packageDir: rootDir,
        packageName: path.basename(rootDir),
        field: 'default',
        filePath: path.resolve(rootDir, defaultEntry),
      });
    }
  }

  return [...byFile.values()]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((entry) => ({
      type: 'sdk_entrypoint',
      filePath: entry.filePath,
      relativePath: entry.relativePath,
      exportName: entry.packageName,
      signature: 'module',
      language: 'javascript',
      runtime: 'node',
      callable: false,
      io: {
        inputs: [],
        output: {
          type: 'module',
          description: 'SDK module entrypoint exports.',
        },
      },
      execution: {
        kind: 'module',
        modulePath: entry.filePath,
        packageDir: entry.packageDir,
        packageName: entry.packageName,
        entryFields: entry.entryFields,
      },
    }));
}

function addCandidate(byFile, candidate) {
  if (!candidate.filePath || !isJavaScriptFile(candidate.filePath) || !fs.existsSync(candidate.filePath)) return;
  const relativePath = path.relative(candidate.rootDir, candidate.filePath);
  const existing = byFile.get(candidate.filePath);
  if (existing) {
    if (!existing.entryFields.includes(candidate.field)) existing.entryFields.push(candidate.field);
    return;
  }
  byFile.set(candidate.filePath, {
    filePath: candidate.filePath,
    relativePath,
    packageDir: candidate.packageDir,
    packageName: candidate.packageName,
    entryFields: [candidate.field],
  });
}

function readPackage(pkgPath) {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function extractExportsPaths(exportsField) {
  const out = [];
  collectExportPaths(exportsField, out);
  return out;
}

function collectExportPaths(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value !== 'object') return;
  for (const child of Object.values(value)) {
    collectExportPaths(child, out);
  }
}

function isJavaScriptFile(filePath) {
  return /\.(js|mjs|cjs)$/.test(filePath);
}

module.exports = { detectSdkEntrypoints };
