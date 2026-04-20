const path = require('path');
const { spawn } = require('child_process');

const PROBE_PATH = path.join(__dirname, 'pythonAstProbe.py');

async function detectPythonExports({ filePath } = {}) {
  if (!filePath || !/\.py$/.test(filePath)) return [];

  const result = await runPythonProbe([PROBE_PATH, filePath]);
  if (!result || !result.ok || !Array.isArray(result.exports)) {
    return [];
  }
  return result.exports;
}

async function runPythonProbe(args) {
  const candidates = getPythonCandidates();
  let lastError = null;

  for (const command of candidates) {
    try {
      return await spawnJson(command, args);
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

function getPythonCandidates() {
  const preferred = process.env.LEUMAS_PYTHON_BIN || process.env.PYTHON;
  const candidates = preferred ? [preferred] : ['python3', 'python'];
  return [...new Set(candidates)];
}

function spawnJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        resolve({
          ok: false,
          error: stderr.trim() || 'Python probe returned invalid JSON',
        });
      }
    });
  });
}

module.exports = { detectPythonExports };
