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

function detectRunnable({ rootDir, filePath, source, packageBinFiles } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = safeStat(filePath);
  const known = RUNNABLE_EXTENSIONS.get(ext) || null;
  const shebang = getShebang({ filePath, source, ext });
  const executable = isExecutable(stat);
  const trustedExecutableBit = executable && (known || shebang || ext === '');
  const script = detectSourceScript({ rootDir, filePath, source, ext, shebang, packageBinFiles });

  if (!known && !shebang && !trustedExecutableBit && !script) return null;

  const runtimeInfo = script || known || inferRuntimeFromShebang(shebang) || {
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
    io: getCliIo(runtimeInfo.parameters),
    execution: createCliExecution({
      rootDir,
      filePath: absPath,
      platform: runtimeInfo.platform,
      runtime: runtimeInfo.runtime,
      shebang,
      executable,
      parameters: runtimeInfo.parameters,
      reason: runtimeInfo.reason,
    }),
  };
}

function createCliExecution({ rootDir, filePath, platform, runtime, shebang, executable, parameters, reason }) {
  const command = getCommandForRuntime({ filePath, runtime });
  const args = getCommandArgsForRuntime({ filePath, runtime });
  const callCommand = buildCallCommand({ command, args });
  const usageCommand = buildUsageCommand({ callCommand, parameters });

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
    ...(parameters && parameters.length ? { parameters } : {}),
    ...(usageCommand !== callCommand ? { usageCommand } : {}),
    ...(reason ? { detectedAs: reason } : {}),
    ...(shebang ? { shebang } : {}),
  };
}

function getCliIo(parameters) {
  const inferred = Array.isArray(parameters) && parameters.length
    ? parameters.map((param) => ({
      name: param.name,
      type: param.type || 'string',
      required: param.required !== false,
      description: param.description || '',
      ...(param.choices ? { choices: param.choices } : {}),
    }))
    : [];

  return {
    inputs: inferred.length ? inferred : [
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

function buildUsageCommand({ callCommand, parameters }) {
  if (!Array.isArray(parameters) || !parameters.length) return callCommand;
  const placeholders = parameters.map((param) => {
    const flag = param.flag || (param.kind === 'option' ? `--${param.name}` : null);
    const value = param.valueName || param.name;
    const token = flag ? `${flag} <${value}>` : `<${value}>`;
    return param.required === false ? `[${token}]` : token;
  });
  return `${callCommand} ${placeholders.join(' ')}`;
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

function detectSourceScript({ rootDir, filePath, source, ext, shebang, packageBinFiles }) {
  if (!['.js', '.mjs', '.cjs', '.py'].includes(ext)) return null;
  const text = typeof source === 'string' ? source : readTextFile(filePath);
  if (!text) return null;

  const relativePath = rootDir ? path.relative(rootDir, filePath) : filePath;
  const normalizedRelativePath = path.normalize(relativePath);
  const binMatch = packageBinFiles && packageBinFiles.has(normalizedRelativePath);

  if (ext === '.py') {
    const reason = getPythonScriptReason({ text, shebang, binMatch, relativePath });
    if (!reason) return null;
    return {
      runtime: 'python_cli',
      language: 'python',
      platform: 'cross-platform',
      reason,
      parameters: inferPythonCliParameters(text),
    };
  }

  const reason = getJavaScriptScriptReason({ text, shebang, binMatch, relativePath });
  if (!reason) return null;
  return {
    runtime: 'node_cli',
    language: 'javascript',
    platform: 'cross-platform',
    reason,
    parameters: inferJavaScriptCliParameters(text),
  };
}

function getPythonScriptReason({ text, shebang, binMatch, relativePath }) {
  if (shebang && shebang.toLowerCase().includes('python')) return 'shebang';
  if (binMatch) return 'package_bin';
  if (/if\s+__name__\s*==\s*["']__main__["']\s*:/.test(text)) return 'python_main_guard';
  if (/\bargparse\.ArgumentParser\s*\(/.test(text)) return 'argparse';
  if (/\bsys\.argv\b/.test(text)) return 'sys_argv';
  if (/@(?:click|typer)\.(?:command|option|argument)\b/.test(text)) return 'decorated_cli';
  if (/\bfire\.Fire\s*\(/.test(text)) return 'python_fire';
  if (isLikelyScriptPath(relativePath) && /\b(main|run|cli)\s*\(/.test(text)) return 'script_path';
  return null;
}

function getJavaScriptScriptReason({ text, shebang, binMatch, relativePath }) {
  if (shebang && shebang.toLowerCase().includes('node')) return 'shebang';
  if (binMatch) return 'package_bin';
  if (/\bprocess\.argv\b/.test(text)) return 'process_argv';
  if (/\brequire\.main\s*===\s*module\b/.test(text)) return 'commonjs_main_guard';
  if (/\bimport\.meta\.url\b/.test(text) && /\bprocess\.argv\[1\]/.test(text)) return 'esm_main_guard';
  if (/\b(?:commander|program|yargs)\.(?:command|argument|option|requiredOption)\s*\(/.test(text)) return 'js_cli_builder';
  if (isLikelyScriptPath(relativePath) && /\b(main|run|cli)\s*\(/.test(text)) return 'script_path';
  return null;
}

function isLikelyScriptPath(relativePath) {
  return String(relativePath || '')
    .split(/[\\/]+/)
    .some((part) => ['bin', 'script', 'scripts', 'cli', 'cmd', 'commands'].includes(part.toLowerCase()));
}

function inferPythonCliParameters(source) {
  const params = [];
  const seen = new Set();
  collectRegexMatches(source, /\.add_argument\s*\(\s*(['"])([^'"]+)\1\s*(?:,\s*(['"])([^'"]+)\3)?([\s\S]*?)\)/g, (match) => {
    const tokens = [match[2], match[4]].filter(Boolean);
    const primary = tokens.find((token) => token.startsWith('--')) || tokens[0];
    const tail = match[5] || '';
    addCliParam(params, seen, {
      name: cleanParamName(primary),
      kind: primary.startsWith('-') ? 'option' : 'argument',
      flag: primary.startsWith('-') ? primary : null,
      required: primary.startsWith('-') ? /required\s*=\s*True/.test(tail) : !/nargs\s*=\s*['"]?[?*]/.test(tail),
      type: inferCliType(tail),
      description: getKeywordString(tail, 'help') || '',
    });
  });
  collectRegexMatches(source, /@(?:click|typer)\.(argument|option)\s*\(\s*(['"])([^'"]+)\2([\s\S]*?)\)/g, (match) => {
    const kind = match[1] === 'option' ? 'option' : 'argument';
    const raw = match[3];
    const tail = match[4] || '';
    addCliParam(params, seen, {
      name: cleanParamName(raw),
      kind,
      flag: kind === 'option' ? raw : null,
      required: kind === 'argument' || /required\s*=\s*True/.test(tail),
      type: inferCliType(tail),
      description: getKeywordString(tail, 'help') || '',
    });
  });
  return params;
}

function inferJavaScriptCliParameters(source) {
  const params = [];
  const seen = new Set();
  collectRegexMatches(source, /\.(argument|option|requiredOption)\s*\(\s*(['"`])([^'"`]+)\2\s*(?:,\s*(['"`])([^'"`]+)\4)?/g, (match) => {
    const kind = match[1] === 'argument' ? 'argument' : 'option';
    const spec = match[3];
    const descriptor = match[5] || '';
    const parsed = parseJsCliSpec(spec, kind);
    addCliParam(params, seen, {
      ...parsed,
      kind,
      required: match[1] === 'requiredOption' || parsed.required,
      description: descriptor,
    });
  });
  collectRegexMatches(source, /process\.argv\.slice\s*\(\s*\d+\s*\)/g, () => {
    addCliParam(params, seen, {
      name: 'args',
      kind: 'argument',
      required: false,
      type: 'array',
      description: 'Arguments read from process.argv.',
    });
  });
  collectRegexMatches(source, /\[\s*,\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*([A-Za-z_$][A-Za-z0-9_$]*))?\s*(?:,\s*([A-Za-z_$][A-Za-z0-9_$]*))?\s*\]\s*=\s*process\.argv/g, (match) => {
    for (const name of match.slice(1).filter(Boolean)) {
      addCliParam(params, seen, {
        name,
        kind: 'argument',
        required: true,
        type: 'string',
        description: 'Positional argument read from process.argv.',
      });
    }
  });
  return params;
}

function parseJsCliSpec(spec, kind) {
  if (kind === 'argument') {
    const optional = /\[[^\]]+\]/.test(spec);
    const raw = (spec.match(/[<[]([^>\]]+)[>\]]/) || [null, spec])[1];
    return {
      name: cleanParamName(raw),
      required: !optional,
      type: 'string',
    };
  }

  const flagMatch = spec.match(/--([A-Za-z0-9_.-]+)/);
  const valueMatch = spec.match(/[<[]([^>\]]+)[>\]]/);
  return {
    name: cleanParamName(flagMatch ? flagMatch[1] : spec),
    flag: flagMatch ? `--${flagMatch[1]}` : spec.split(/[,\s]+/).find((part) => part.startsWith('-')),
    required: /<[^>]+>/.test(spec),
    type: valueMatch ? 'string' : 'boolean',
    valueName: valueMatch ? cleanParamName(valueMatch[1]) : null,
  };
}

function addCliParam(params, seen, param) {
  if (!param || !param.name) return;
  const key = `${param.kind || 'argument'}:${param.name}`;
  if (seen.has(key)) return;
  seen.add(key);
  params.push(param);
}

function cleanParamName(value) {
  return String(value || 'arg')
    .replace(/^--?/, '')
    .replace(/[<>\[\]]/g, '')
    .replace(/\s+/g, '_')
    .trim() || 'arg';
}

function inferCliType(text) {
  const raw = String(text || '');
  if (/\b(?:int|float|Number)\b/.test(raw)) return 'number';
  if (/\bbool\b|store_true|store_false/.test(raw)) return 'boolean';
  if (/\bnargs\s*=/.test(raw)) return 'array';
  return 'string';
}

function getKeywordString(text, keyword) {
  const pattern = new RegExp(`${keyword}\\s*=\\s*(['"])(.*?)\\1`);
  const match = String(text || '').match(pattern);
  return match ? match[2] : null;
}

function collectRegexMatches(source, pattern, onMatch) {
  let match;
  while ((match = pattern.exec(source))) {
    onMatch(match);
  }
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

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
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
