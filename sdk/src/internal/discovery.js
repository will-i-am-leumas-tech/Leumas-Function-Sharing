const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
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

async function findIndexFiles(rootDir, ignoreSet) {
  const results = [];
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
      if (entry.isFile() && entry.name === 'functionIndex.json' && path.basename(path.dirname(fullPath)) === '.leumas') {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function findAllIndexes(rootPath) {
  const targetRoot = path.resolve(rootPath || process.cwd());
  const ignoreSet = new Set(DEFAULT_IGNORES);
  const files = await findIndexFiles(targetRoot, ignoreSet);

  const indexes = [];
  for (const file of files) {
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      indexes.push({
        path: file,
        project: parsed.project || null,
        summary: parsed.summary || null,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      });
    } catch (err) {
      continue;
    }
  }

  return indexes;
}

module.exports = { findAllIndexes };
