const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config/loadConfig');
const { writeCache } = require('./cache');

const DEFAULT_IGNORES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  'vendor',
  'my-env',
  'mp-env',
  'venv',
  '.venv',
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
      if (entry.isFile()) {
        if (entry.name === 'functionIndex.json' && path.basename(path.dirname(fullPath)) === '.leumas') {
          results.push(fullPath);
        }
      }
    }
  }

  return results;
}

async function discoverIndexes({ roots, cachePath } = {}) {
  const config = loadConfig();
  const rootList = Array.isArray(roots) && roots.length ? roots : config.roots;
  const ignoreSet = new Set(DEFAULT_IGNORES);
  const indexes = [];

  for (const root of rootList) {
    const absRoot = path.resolve(root);
    const files = await findIndexFiles(absRoot, ignoreSet);
    for (const file of files) {
      try {
        const raw = await fs.promises.readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        indexes.push({
          path: file,
          project: parsed.project || null,
          entries: parsed.entries || [],
        });
      } catch (err) {
        continue;
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    roots: rootList,
    indexes,
  };

  await writeCache({ cachePath, payload });
  return payload;
}

module.exports = { discoverIndexes };
