const fs = require('fs');
const path = require('path');

const RUNNABLE_EXTENSIONS = new Map([
  ['.bat', { runtime: 'cmd', language: 'batch', platform: 'win32' }],
  ['.cmd', { runtime: 'cmd', language: 'batch', platform: 'win32' }],
  ['.ps1', { runtime: 'powershell', language: 'powershell', platform: 'cross-platform' }],
  ['.psm1', { runtime: 'powershell', language: 'powershell', platform: 'cross-platform' }],
  ['.sh', { runtime: 'shell', language: 'shell', platform: 'posix' }],
  ['.bash', { runtime: 'shell', language: 'shell', platform: 'posix' }],
  ['.zsh', { runtime: 'shell', language: 'shell', platform: 'posix' }],
  ['.fish', { runtime: 'shell', language: 'shell', platform: 'posix' }],
  ['.ksh', { runtime: 'shell', language: 'shell', platform: 'posix' }],
  ['.run', { runtime: 'binary', language: 'binary', platform: 'posix' }],
  ['.bin', { runtime: 'binary', language: 'binary', platform: 'cross-platform' }],
  ['.exe', { runtime: 'binary', language: 'binary', platform: 'win32' }],
  ['.com', { runtime: 'binary', language: 'binary', platform: 'win32' }],
  ['.msi', { runtime: 'installer', language: 'binary', platform: 'win32' }],
  ['.app', { runtime: 'app_bundle', language: 'binary', platform: 'darwin' }],
]);

const TEXT_EXTENSIONS = new Set([
  '',
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ksh',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.pl',
  '.php',
]);

function detectRunnable({ rootDir, filePath, source }) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = safeStat(filePath);
  const known = RUNNABLE_EXTENSIONS.get(ext) || null;
  const shebang = getShebang({ filePath, source, ext });
  const executable = isExecutable(stat);
  const trustedExecutableBit = executable && (known || shebang || ext === '');

  if (!known && !shebang && !trustedExecutableBit) return null;

  const runtimeInfo = known || inferRuntimeFromShebang(shebang) || {
    runtime: ext ? 'binary' : 'executable',
    language: ext ? 'binary' : 'unknown',
    platform: 'cross-platform',
  };

  const absPath = path.resolve(filePath);
  const name = path.basename(filePath);

  return {
    type: 'cli_command',
    exportName: name,
    signature: '[...args]',
    language: runtimeInfo.language,
    runtime: runtimeInfo.runtime,
    callable: true,
    io: {
      inputs: [
        {
          name: 'args',
          type: 'array',
          required: false,
          description: 'Command-line arguments passed to the runnable.',
          items: { type: 'string' },
        },
      ],
      output: {
        type: 'process_result',
        description: 'Exit code, stdout, and stderr from the runnable process.',
      },
    },
    execution: createCliExecution({
      rootDir,
      filePath: absPath,
      platform: runtimeInfo.platform,
      runtime: runtimeInfo.runtime,
      shebang,
      executable,
    }),
  };
}

function createCliExecution({ rootDir, filePath, platform, runtime, shebang, executable }) {
  const command = getCommandForRuntime({ filePath, runtime });
  const args = getCommandArgsForRuntime({ filePath, runtime });
  const callCommand = buildCallCommand({ command, args });

  return {
    kind: 'cli',
    filePath,
    command,
    args,
    callCommand,
    cwd: rootDir,
    platform,
    runtime,
    executable,
    ...(shebang ? { shebang } : {}),
  };
}

function getCommandForRuntime({ filePath, runtime }) {
  if (runtime === 'cmd') return 'cmd.exe';
  if (runtime === 'powershell') return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  if (runtime === 'python_cli') return process.env.LEUMAS_PYTHON_BIN || process.env.PYTHON || 'python3';
  if (runtime === 'node_cli') return 'node';
  if (runtime === 'shell' && !isExecutable(safeStat(filePath))) return '/bin/sh';
  if (runtime === 'installer') return process.platform === 'win32' ? 'msiexec.exe' : filePath;
  if (runtime === 'app_bundle') return 'open';
  return filePath;
}

function getCommandArgsForRuntime({ filePath, runtime }) {
  if (runtime === 'cmd') return ['/d', '/s', '/c', filePath];
  if (runtime === 'powershell') return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filePath];
  if (runtime === 'python_cli') return [filePath];
  if (runtime === 'node_cli') return [filePath];
  if (runtime === 'shell' && !isExecutable(safeStat(filePath))) return [filePath];
  if (runtime === 'installer') return process.platform === 'win32' ? ['/i', filePath] : [];
  if (runtime === 'app_bundle') return [filePath];
  return [];
}

function buildCallCommand({ command, args }) {
  return [command, ...(args || [])].map(quoteShellArg).join(' ');
}

function quoteShellArg(value) {
  const raw = String(value || '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(raw)) return raw;
  return `"${raw.replace(/(["\\$`])/g, '\\$1')}"`;
}

function inferRuntimeFromShebang(shebang) {
  if (!shebang) return null;
  const lower = shebang.toLowerCase();
  if (lower.includes('python')) return { runtime: 'python_cli', language: 'python', platform: 'cross-platform' };
  if (lower.includes('node')) return { runtime: 'node_cli', language: 'javascript', platform: 'cross-platform' };
  if (lower.includes('bash') || lower.includes(' sh') || lower.endsWith('/sh')) {
    return { runtime: 'shell', language: 'shell', platform: 'posix' };
  }
  if (lower.includes('pwsh') || lower.includes('powershell')) {
    return { runtime: 'powershell', language: 'powershell', platform: 'cross-platform' };
  }
  return { runtime: 'executable', language: 'unknown', platform: 'cross-platform' };
}

function getShebang({ filePath, source, ext }) {
  if (!TEXT_EXTENSIONS.has(ext)) return null;
  let text = source;
  if (typeof text !== 'string') {
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      return null;
    }
  }
  const firstLine = String(text).split(/\r?\n/, 1)[0];
  return firstLine.startsWith('#!') ? firstLine.slice(2).trim() : null;
}

function isExecutable(stat) {
  if (!stat || !stat.isFile()) return false;
  return (stat.mode & 0o111) !== 0;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (err) {
    return null;
  }
}

module.exports = { detectRunnable };
