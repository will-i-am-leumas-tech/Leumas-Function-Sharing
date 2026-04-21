const fs = require('fs');
const path = require('path');
const { indexProject } = require('./internal/indexer/indexProject');
const { remoteIndexGitRepo, bulkRemoteIndexGitRepos } = require('./internal/indexer/remoteIndexGitRepos');
const { findAllIndexes } = require('./internal/discovery');
const { runMeshEntry } = require('./internal/exec/runMeshEntry');
const { runNodeFunction } = require('./internal/exec/runNodeFunction');
const { normalizeRuntimePath } = require('./internal/shared/runtimePaths');

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

async function createIndex(targetPath, options = {}) {
  const rootDir = path.resolve(targetPath || process.cwd());
  const outFile = options.outFile ? path.resolve(options.outFile) : undefined;
  const result = await indexProject({ rootDir, outFile });
  return {
    path: result.outputPath,
    index: result.index,
  };
}

async function findAllIndex(targetPath) {
  const indexes = await findAllIndexes(targetPath);
  return indexes.map((idx) => normalizeIndexPayload(idx));
}

async function bulkCreateIndexes(paths, options = {}) {
  if (!Array.isArray(paths)) {
    throw new Error('`paths` must be an array of project directories.');
  }

  const concurrency = normalizeConcurrency(options.concurrency);
  const continueOnError = options.continueOnError !== false;
  const startedAt = new Date().toISOString();
  const results = await mapConcurrent(paths, concurrency, async (inputPath) => {
    const started = Date.now();
    const resolvedPath = path.resolve(String(inputPath));
    try {
      await assertDirectory(resolvedPath);
      const created = await createIndex(resolvedPath);
      const entries = Array.isArray(created.index.entries) ? created.index.entries : [];
      return {
        ok: true,
        path: resolvedPath,
        indexPath: created.path,
        project: created.index.project || null,
        summary: created.index.summary || null,
        entries: entries.length,
        callable: entries.filter((entry) => entry.callable).length,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const result = {
        ok: false,
        path: resolvedPath,
        indexPath: path.join(resolvedPath, '.leumas', 'functionIndex.json'),
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

async function bulkCreateIndexesFromDirectory(parentDir, options = {}) {
  const resolvedParent = resolveInputPath(parentDir || process.cwd());
  await assertDirectory(resolvedParent);
  const childDirectories = await listChildDirectories(resolvedParent, options);
  const result = await bulkCreateIndexes(childDirectories, options);

  return {
    ...result,
    parentPath: resolvedParent,
    discoveredProjects: childDirectories.length,
  };
}

async function remoteCreateIndex(gitUrl, options = {}) {
  return remoteIndexGitRepo(gitUrl, {
    outputDir: options.outputDir,
    cloneRoot: options.cloneRoot,
    keepClone: options.keepClone,
    ref: options.ref,
    cloneTimeoutMs: options.cloneTimeoutMs,
  });
}

async function bulkRemoteCreateIndexes(gitUrls, options = {}) {
  return bulkRemoteIndexGitRepos(gitUrls, {
    outputDir: options.outputDir,
    cloneRoot: options.cloneRoot,
    keepClone: options.keepClone,
    ref: options.ref,
    cloneTimeoutMs: options.cloneTimeoutMs,
    concurrency: options.concurrency,
    continueOnError: options.continueOnError,
  });
}

async function assertDirectory(dirPath) {
  const stat = await fs.promises.stat(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
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

function resolveInputPath(inputPath) {
  return path.resolve(normalizeRuntimePath(String(inputPath)));
}

async function callFunctionInIndex(options = {}) {
  const {
    indexPath,
    index,
    entryId,
    exportName,
    args = [],
    mode = 'import',
    timeoutMs = 5000,
  } = options;

  const loadedIndex = normalizeIndexPayload(index || (indexPath ? await readIndexFile(indexPath) : null));
  if (!loadedIndex) {
    throw new Error('Provide either `index` or `indexPath`.');
  }

  const entries = Array.isArray(loadedIndex.entries) ? loadedIndex.entries : [];
  const entry = selectEntry({ entries, entryId, exportName });
  if (!entry) {
    throw new Error('Matching entry not found in index.');
  }

  return runNodeFunction({
    entry,
    args,
    mode,
    timeoutMs,
  });
}

async function indexStats(targetPath) {
  const resolved = path.resolve(targetPath || process.cwd());
  const directIndexPath = isIndexFilePath(resolved)
    ? resolved
    : path.join(resolved, '.leumas', 'functionIndex.json');

  let indexes;
  if (await fileExists(directIndexPath)) {
    indexes = [{ path: directIndexPath, ...(await readIndexFile(directIndexPath)) }];
  } else {
    indexes = await findAllIndexes(resolved);
  }

  const totals = {
    indexes: indexes.length,
    entries: 0,
    callable: 0,
    byType: {
      node_function: 0,
      python_function: 0,
      python_class: 0,
      cli_command: 0,
      express_route: 0,
      react_component: 0,
      react_hook: 0,
      sdk_entrypoint: 0,
      util: 0,
      unknown: 0,
    },
  };

  for (const idx of indexes) {
    for (const entry of idx.entries || []) {
      totals.entries += 1;
      if (entry.callable) totals.callable += 1;
      if (totals.byType[entry.type] !== undefined) totals.byType[entry.type] += 1;
      else totals.byType.unknown += 1;
    }
  }

  return {
    root: resolved,
    totals,
    projects: indexes.map((idx) => ({
      path: idx.path,
      name: idx.project && idx.project.name ? idx.project.name : null,
      version: idx.project && idx.project.version ? idx.project.version : null,
      entries: Array.isArray(idx.entries) ? idx.entries.length : 0,
      callable: Array.isArray(idx.entries) ? idx.entries.filter((entry) => entry.callable).length : 0,
    })),
  };
}

async function bulkIndexStatus(paths, options = {}) {
  if (!Array.isArray(paths)) {
    throw new Error('`paths` must be an array of paths.');
  }

  const concurrency = normalizeConcurrency(options.concurrency);
  return mapConcurrent(paths, concurrency, async (inputPath) => {
    const resolvedPath = path.resolve(String(inputPath));
    const leumasDir = path.join(resolvedPath, '.leumas');
    const indexPath = path.join(leumasDir, 'functionIndex.json');

    const hasLeumasDir = await isDirectory(leumasDir);
    const hasIndexFile = await isFile(indexPath);

    if (!hasIndexFile) {
      return {
        path: resolvedPath,
        hasLeumasDir,
        hasIndexFile: false,
        indexPath,
        project: null,
        summary: null,
        stats: null,
      };
    }

    try {
      const parsed = await readIndexFile(indexPath);
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      const stats = parsed.summary && parsed.summary.totals
        ? parsed.summary.totals
        : deriveTotalsFromEntries(entries);

      return {
        path: resolvedPath,
        hasLeumasDir,
        hasIndexFile: true,
        indexPath,
        project: parsed.project || null,
        summary: parsed.summary || null,
        stats,
      };
    } catch (err) {
      return {
        path: resolvedPath,
        hasLeumasDir,
        hasIndexFile: true,
        indexPath,
        project: null,
        summary: null,
        stats: null,
        error: err && err.message ? err.message : String(err),
      };
    }
  });
}

function selectEntry({ entries, entryId, exportName }) {
  if (entryId) {
    return entries.find((entry) => entry.id === entryId);
  }
  if (exportName) {
    const candidates = entries.filter((entry) => entry.exportName === exportName);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error('Multiple entries found for exportName. Provide `entryId` instead.');
    }
  }
  return null;
}

async function readIndexFile(indexPath) {
  const raw = await fs.promises.readFile(path.resolve(indexPath), 'utf8');
  return normalizeIndexPayload(JSON.parse(raw));
}

function isIndexFilePath(filePath) {
  return path.basename(filePath) === 'functionIndex.json';
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (err) {
    return false;
  }
}

function normalizeIndexPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const entries = Array.isArray(payload.entries) ? payload.entries.map(normalizeEntryIo) : [];
  return {
    ...payload,
    entries,
  };
}

function normalizeEntryIo(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.io && Array.isArray(entry.io.inputs) && entry.io.output) return entry;

  const inferredInputs = parseInputsFromSignature(entry.signature);
  const fallbackInputs = inferredInputs.length > 0
    ? inferredInputs
    : [];

  return {
    ...entry,
    io: {
      inputs: fallbackInputs,
      output: { type: 'unknown', description: '' },
    },
  };
}

function parseInputsFromSignature(signature) {
  if (typeof signature !== 'string' || signature.length < 2) return [];
  const trimmed = signature.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return [];
  const raw = trimmed.slice(1, -1).trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((token) => {
      const hasDefault = token.includes('=');
      const name = token
        .replace(/\s*=.+$/, '')
        .replace(/^\.\.\./, '')
        .trim();
      return {
        name,
        type: 'unknown',
        required: !hasDefault,
        description: '',
      };
    })
    .filter((input) => input.name && input.name !== '{...}' && input.name !== '[...]');
}

async function isDirectory(dirPath) {
  try {
    const stat = await fs.promises.stat(dirPath);
    return stat.isDirectory();
  } catch (err) {
    return false;
  }
}

async function isFile(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch (err) {
    return false;
  }
}

function normalizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 64;
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

function deriveTotalsFromEntries(entries) {
  const totals = {
    total: 0,
    node_function: 0,
    python_function: 0,
    python_class: 0,
    cli_command: 0,
    express_route: 0,
    react_component: 0,
    react_hook: 0,
    sdk_entrypoint: 0,
    util: 0,
    unknown: 0,
    callable: 0,
  };

  for (const entry of entries) {
    totals.total += 1;
    if (entry && totals[entry.type] !== undefined) totals[entry.type] += 1;
    else totals.unknown += 1;
    if (entry && entry.callable) totals.callable += 1;
  }

  return totals;
}

module.exports = {
  createIndex,
  bulkCreateIndexes,
  bulkCreateIndexesFromDirectory,
  remoteCreateIndex,
  bulkRemoteCreateIndexes,
  findAllIndex,
  callFunctionInIndex,
  runMeshEntry,
  indexStats,
  bulkIndexStatus,
};
