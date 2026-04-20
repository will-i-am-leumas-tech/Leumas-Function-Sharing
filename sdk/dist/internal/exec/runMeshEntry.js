const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { normalizeEntryForRuntime } = require('../shared/runtimePaths');

async function runMeshEntry({ entryId, entry, registry, args = [], mode = 'runner', timeoutMs = 5000 } = {}) {
  const targetEntry = normalizeEntryForRuntime(entry || resolveEntry({ entryId, registry }));
  if (!targetEntry) {
    throw new Error('Entry not found');
  }
  if (!targetEntry.callable) {
    throw new Error('Entry is not callable. Add @mesh callable or mesh.exports.json');
  }

  if (targetEntry.execution && targetEntry.execution.kind === 'python_import') {
    return runPythonRunnerMode(targetEntry, args, timeoutMs);
  }
  if (targetEntry.execution && targetEntry.execution.kind === 'cli') {
    return runCliMode(targetEntry, args, timeoutMs);
  }
  if (targetEntry.execution && targetEntry.execution.kind === 'import' && mode === 'import') {
    return runImportMode(targetEntry, args);
  }
  return runNodeRunnerMode(targetEntry, args, timeoutMs);
}

function resolveEntry({ entryId, registry }) {
  if (!entryId) return null;
  if (!Array.isArray(registry)) return null;
  return registry.find((e) => e.id === entryId);
}

async function runImportMode(entry, args) {
  const mod = await import(pathToFileURL(entry.execution.modulePath).href);
  const fn = entry.exportName === 'default' ? mod.default : mod[entry.exportName];
  if (typeof fn !== 'function') {
    throw new Error(`Export ${entry.exportName} is not a function`);
  }
  const result = await fn(...args);
  return { ok: true, result };
}

async function runNodeRunnerMode(entry, args, timeoutMs) {
  const runnerPath = path.join(__dirname, 'runner', 'runner.js');
  const payload = JSON.stringify({
    modulePath: entry.execution.modulePath,
    exportName: entry.exportName,
    args,
  });

  return spawnJsonProcess(process.execPath, [runnerPath, payload], timeoutMs, {
    failOnStderr: true,
  });
}

async function runPythonRunnerMode(entry, args, timeoutMs) {
  const runnerPath = path.join(__dirname, 'runner', 'pythonRunner.py');
  const payload = JSON.stringify({
    modulePath: entry.execution.modulePath,
    moduleName: entry.execution.moduleName,
    projectRoot: entry.execution.projectRoot,
    exportName: entry.exportName,
    args,
  });
  const candidates = getPythonCandidates();
  let lastError = null;

  for (const command of candidates) {
    try {
      return await spawnJsonProcess(command, [runnerPath, payload], timeoutMs);
    } catch (err) {
      lastError = err;
      if (!err || err.code !== 'ENOENT') break;
    }
  }

  if (lastError && lastError.code !== 'ENOENT') {
    throw lastError;
  }
  return { ok: false, error: 'Python executable not found' };
}

async function runCliMode(entry, args, timeoutMs) {
  const execution = entry.execution || {};
  const command = execution.command || execution.filePath;
  const runtimeArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const commandArgs = [
    ...(Array.isArray(execution.args) ? execution.args : []),
    ...(execution.appendArgsSeparator && runtimeArgs.length ? [execution.appendArgsSeparator] : []),
    ...runtimeArgs,
  ];

  return spawnProcess(command, commandArgs, timeoutMs, {
    cwd: execution.cwd,
  });
}

function getPythonCandidates() {
  const preferred = process.env.LEUMAS_PYTHON_BIN || process.env.PYTHON;
  const candidates = preferred ? [preferred] : ['python3', 'python'];
  return [...new Set(candidates)];
}

function spawnProcess(command, args, timeoutMs, options = {}) {
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
      resolve({ ok: false, error: 'Timeout exceeded', stdout, stderr });
    }, timeoutMs);

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
      resolve({
        ok: code === 0,
        result: {
          code,
          signal,
          stdout,
          stderr,
        },
        ...(code === 0 ? {} : { error: `Process exited with code ${code}` }),
      });
    });
  });
}

function spawnJsonProcess(command, args, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, error: 'Timeout exceeded' });
    }, timeoutMs);

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
    child.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      if (options.failOnStderr && stderr) {
        resolve({ ok: false, error: stderr.trim() });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        resolve({ ok: false, error: stderr.trim() || 'Runner returned invalid JSON' });
      }
    });
  });
}

module.exports = { runMeshEntry, resolveEntry };
