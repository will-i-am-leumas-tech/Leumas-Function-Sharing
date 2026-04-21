const path = require('path');
const os = require('os');
const fs = require('fs');
const { indexProject } = require('./indexProject');
const { normalizeRuntimePath } = require('../shared/runtimePaths');

const DEFAULT_CHILD_DIR_IGNORES = new Set([
  '.git',
  '.leumas',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
]);

async function bulkIndexProjects(paths, options = {}) {
  if (!Array.isArray(paths)) {
    throw new Error('`paths` must be an array of project directories.');
  }

  const resolvedPaths = paths
    .map(resolveInputPath)
    .filter(Boolean);
  const concurrency = normalizeConcurrency(options.concurrency);
  const continueOnError = options.continueOnError !== false;
  const startedAt = new Date().toISOString();

  const results = await mapConcurrent(resolvedPaths, concurrency, async (rootDir) => {
    const started = Date.now();
    try {
      await assertDirectory(rootDir);
      const index = await indexProject({ rootDir });
      return {
        ok: true,
        path: rootDir,
        indexPath: path.join(rootDir, '.leumas', 'functionIndex.json'),
        project: index.project || null,
        summary: index.summary || null,
        entries: Array.isArray(index.entries) ? index.entries.length : 0,
        callable: Array.isArray(index.entries) ? index.entries.filter((entry) => entry.callable).length : 0,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const result = {
        ok: false,
        path: rootDir,
        indexPath: path.join(rootDir, '.leumas', 'functionIndex.json'),
        error: err && err.message ? err.message : String(err),
        durationMs: Date.now() - started,
      };
      if (!continueOnError) throw Object.assign(err, { result });
      return result;
    }
  });

  const totals = results.reduce((acc, result) => {
    acc.projects += 1;
    if (result.ok) acc.ok += 1;
    else acc.failed += 1;
    acc.entries += result.entries || 0;
    acc.callable += result.callable || 0;
    return acc;
  }, {
    projects: 0,
    ok: 0,
    failed: 0,
    entries: 0,
    callable: 0,
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    concurrency,
    totals,
    results,
  };
}

async function bulkIndexChildDirectories(parentDir, options = {}) {
  const resolvedParent = resolveInputPath(parentDir || process.cwd());
  await assertDirectory(resolvedParent);
  const childDirectories = await listChildDirectories(resolvedParent, options);
  const result = await bulkIndexProjects(childDirectories, options);

  return {
    ...result,
    parentPath: resolvedParent,
    discoveredProjects: childDirectories.length,
  };
}

async function listChildDirectories(parentDir, options = {}) {
  const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
  const includeHidden = Boolean(options.includeHidden);
  const includeIgnored = Boolean(options.includeIgnored);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => includeHidden || !name.startsWith('.'))
    .filter((name) => includeIgnored || !DEFAULT_CHILD_DIR_IGNORES.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(parentDir, name));
}

async function assertDirectory(rootDir) {
  const stat = await fs.promises.stat(rootDir);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }
}

function resolveInputPath(inputPath) {
  return path.resolve(normalizeRuntimePath(String(inputPath)));
}

function normalizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return Math.max(1, Math.min(4, os.cpus().length || 1));
  }
  return Math.max(1, Math.floor(num));
}

async function mapConcurrent(items, concurrency, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const pool = [];
  for (let i = 0; i < workerCount; i += 1) {
    pool.push(runWorker());
  }
  await Promise.all(pool);
  return results;
}

module.exports = {
  bulkIndexProjects,
  bulkIndexChildDirectories,
  listChildDirectories,
};
