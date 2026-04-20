const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { indexProject } = require('./indexProject');

async function remoteIndexGitRepo(gitUrl, options = {}) {
  if (!gitUrl || typeof gitUrl !== 'string') {
    throw new Error('`gitUrl` must be a Git repository URL.');
  }

  const started = Date.now();
  const repoSlug = getRepoSlug(gitUrl);
  const uniqueSlug = `${repoSlug}-${shortHash(gitUrl)}`;
  const outputRoot = path.resolve(options.outputDir || path.join(process.cwd(), '.leumas', 'remote'));
  const outFile = path.join(outputRoot, uniqueSlug, '.leumas', 'functionIndex.json');
  const cloneRoot = options.cloneRoot
    ? path.resolve(options.cloneRoot)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'leumas-remote-'));
  const clonePath = path.join(cloneRoot, uniqueSlug);
  const keepClone = Boolean(options.keepClone || options.cloneRoot);

  try {
    await cloneGitRepo({
      gitUrl,
      clonePath,
      ref: options.ref,
      timeoutMs: options.cloneTimeoutMs,
    });
    const index = await indexProject({ rootDir: clonePath, outFile });
    const entries = Array.isArray(index.entries) ? index.entries : [];
    return {
      ok: true,
      gitUrl,
      ref: options.ref || null,
      repoSlug,
      path: clonePath,
      clonePath,
      cloneKept: keepClone,
      outputDir: path.dirname(outFile),
      indexPath: outFile,
      project: index.project || null,
      summary: index.summary || null,
      entries: entries.length,
      callable: entries.filter((entry) => entry.callable).length,
      durationMs: Date.now() - started,
      index,
    };
  } finally {
    if (!keepClone) {
      await removePath(cloneRoot);
    }
  }
}

async function bulkRemoteIndexGitRepos(gitUrls, options = {}) {
  if (!Array.isArray(gitUrls)) {
    throw new Error('`gitUrls` must be an array of Git repository URLs.');
  }

  const urls = gitUrls.map((url) => String(url || '').trim()).filter(Boolean);
  const concurrency = normalizeConcurrency(options.concurrency);
  const continueOnError = options.continueOnError !== false;
  const startedAt = new Date().toISOString();
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.join(process.cwd(), '.leumas', 'remote');

  const results = await mapConcurrent(urls, concurrency, async (gitUrl) => {
    try {
      return await remoteIndexGitRepo(gitUrl, {
        ...options,
        outputDir,
      });
    } catch (err) {
      const result = {
        ok: false,
        gitUrl,
        ref: options.ref || null,
        repoSlug: getRepoSlug(gitUrl),
        indexPath: path.join(outputDir, `${getRepoSlug(gitUrl)}-${shortHash(gitUrl)}`, '.leumas', 'functionIndex.json'),
        error: err && err.message ? err.message : String(err),
      };
      if (!continueOnError) throw Object.assign(err, { result });
      return result;
    }
  });

  const totals = results.reduce((acc, result) => {
    acc.repositories += 1;
    if (result.ok) acc.ok += 1;
    else acc.failed += 1;
    acc.entries += result.entries || 0;
    acc.callable += result.callable || 0;
    return acc;
  }, {
    repositories: 0,
    ok: 0,
    failed: 0,
    entries: 0,
    callable: 0,
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    outputDir,
    concurrency,
    totals,
    results,
  };
}

async function cloneGitRepo({ gitUrl, clonePath, ref, timeoutMs = 120000 }) {
  await fs.promises.mkdir(path.dirname(clonePath), { recursive: true });
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (ref) args.push('--branch', ref);
  args.push(gitUrl, clonePath);
  const result = await runCommand('git', args, { timeoutMs });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git clone failed with code ${result.code}`);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'SIGKILL', stdout, stderr: stderr || 'Timeout exceeded' });
    }, options.timeoutMs || 120000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function getRepoSlug(gitUrl) {
  const withoutHash = String(gitUrl).split('#')[0].replace(/[/?#]+$/, '');
  const last = withoutHash.split(/[/:\\]+/).filter(Boolean).pop() || 'repo';
  return safeName(last.replace(/\.git$/i, '')) || 'repo';
}

function safeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function shortHash(value) {
  let hash = 2166136261;
  const raw = String(value || '');
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

async function removePath(targetPath) {
  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
}

function normalizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return Math.max(1, Math.min(2, os.cpus().length || 1));
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
  remoteIndexGitRepo,
  bulkRemoteIndexGitRepos,
  getRepoSlug,
};
