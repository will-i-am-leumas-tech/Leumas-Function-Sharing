const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

async function runNodeFunction({ entryId, entry, registry, args = [], mode = 'runner', timeoutMs = 5000 } = {}) {
  const targetEntry = entry || resolveEntry({ entryId, registry });
  if (!targetEntry) {
    throw new Error('Entry not found');
  }
  if (!targetEntry.callable) {
    throw new Error('Entry is not callable. Add @mesh callable or mesh.exports.json');
  }
  if (targetEntry.execution && targetEntry.execution.kind === 'import' && mode === 'import') {
    return runImportMode(targetEntry, args);
  }
  return runRunnerMode(targetEntry, args, timeoutMs);
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

async function runRunnerMode(entry, args, timeoutMs) {
  const runnerPath = path.join(__dirname, 'runner', 'runner.js');
  const payload = JSON.stringify({
    modulePath: entry.execution.modulePath,
    exportName: entry.exportName,
    args,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, payload], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
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
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (stderr) {
        resolve({ ok: false, error: stderr.trim() });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (err) {
        resolve({ ok: false, error: 'Runner returned invalid JSON' });
      }
    });
  });
}

module.exports = { runNodeFunction };
