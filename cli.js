#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { runMeshEntry } = require('./src/exec/runMeshEntry');

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

const BOOLEAN_OPTIONS = new Set(['help', 'h', 'list', 'json', 'cwd']);
const VALUE_OPTIONS = new Set(['root', 'roots', 'entry', 'args', 'timeout', 'mode']);

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const roots = getRoots(args);
  const indexes = await loadMeshIndexes({ roots });
  const entries = getCallableEntries(indexes);

  if (args.list) {
    writeEntryList(entries, Boolean(args.json));
    return;
  }

  if (!entries.length) {
    process.stdout.write(`No callable entries found under ${roots.join(', ')}\n`);
    return;
  }

  const selected = args.entry
    ? selectEntryById(entries, args.entry)
    : await selectFromMenu({
      title: 'Leumas Function Mesh',
      items: entries,
      formatItem: formatEntryLabel,
    });

  if (!selected) return;

  const runtimeArgs = args.args
    ? parseArgsJson(args.args)
    : await promptEntryArgs(selected);
  const timeoutMs = args.timeout ? Number(args.timeout) : 30000;
  const result = await runMeshEntry({
    entry: selected,
    args: runtimeArgs,
    mode: args.mode || 'runner',
    timeoutMs,
  });

  writeRunResult(result, Boolean(args.json));
}

function parseArgs(argv) {
  const out = { _: [] };
  let key = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      const name = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
      const value = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
      if (value !== undefined) {
        out[name] = value;
        key = null;
      } else if (BOOLEAN_OPTIONS.has(name)) {
        out[name] = true;
        key = null;
      } else {
        out[name] = true;
        key = VALUE_OPTIONS.has(name) ? name : null;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(1);
      out[name] = true;
      key = VALUE_OPTIONS.has(name) ? name : null;
      continue;
    }
    if (key) {
      out[key] = arg;
      key = null;
      continue;
    }
    out._.push(arg);
  }
  return out;
}

function getRoots(args) {
  const explicit = [
    ...args._,
    ...(args.root ? parsePathList(args.root) : []),
    ...(args.roots ? parsePathList(args.roots) : []),
  ];
  if (explicit.length) return explicit.map((item) => path.resolve(item));
  if (args.cwd) return [process.cwd()];
  return [getCurrentDriveRoot(process.cwd())];
}

function parsePathList(raw) {
  return splitPathList(String(raw || ''), path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitPathList(raw, delimiter) {
  const out = [];
  let current = '';
  for (let idx = 0; idx < raw.length; idx += 1) {
    const char = raw[idx];
    const isSeparator = char === ',' || char === '\n' || char === '\r' || char === delimiter;
    if (isSeparator && !isWindowsDriveColon(raw, idx)) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function isWindowsDriveColon(raw, idx) {
  if (raw[idx] !== ':') return false;
  const prev = raw[idx - 1] || '';
  const next = raw[idx + 1] || '';
  const beforeDrive = raw[idx - 2] || '';
  const driveStartsToken = idx === 1 || beforeDrive === ',' || beforeDrive === '\n' || beforeDrive === '\r' || beforeDrive === ';';
  return driveStartsToken && /^[A-Za-z]$/.test(prev) && (next === '\\' || next === '/');
}

function getCurrentDriveRoot(cwd) {
  const current = path.resolve(cwd || process.cwd());
  const wslMatch = current.match(/^\/mnt\/([a-zA-Z])(?:\/|$)/);
  if (wslMatch) return `/mnt/${wslMatch[1].toLowerCase()}`;
  return path.parse(current).root || current;
}

async function loadMeshIndexes({ roots }) {
  const files = await findMeshIndexFiles(roots);
  const indexes = [];

  for (const indexPath of files) {
    try {
      const raw = await fs.promises.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      indexes.push({
        path: indexPath,
        project: parsed.project || null,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      });
    } catch (err) {
      // Ignore stale or partially-written indexes while browsing.
    }
  }

  return indexes.sort((a, b) => compareString(projectName(a), projectName(b)) || compareString(a.path, b.path));
}

async function findMeshIndexFiles(roots) {
  const out = [];
  for (const root of roots) {
    await walkForIndexes(path.resolve(root), out);
  }
  return [...new Set(out)].sort(compareString);
}

async function walkForIndexes(rootDir, out) {
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
        if (entry.name === '.leumas') {
          const indexPath = path.join(fullPath, 'functionIndex.json');
          if (await isFile(indexPath)) out.push(indexPath);
          continue;
        }
        if (!DEFAULT_IGNORES.has(entry.name)) queue.push(fullPath);
      }
    }
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

function getCallableEntries(indexes) {
  const entries = [];
  for (const index of indexes) {
    for (const entry of index.entries) {
      if (!entry || !entry.callable || !entry.execution) continue;
      entries.push({
        ...entry,
        __indexPath: index.path,
        __project: index.project || null,
      });
    }
  }

  return entries.sort((a, b) => {
    return compareString(projectName({ project: a.__project, path: a.__indexPath }), projectName({ project: b.__project, path: b.__indexPath }))
      || compareString(a.type, b.type)
      || compareString(a.relativePath, b.relativePath)
      || compareString(a.exportName, b.exportName);
  });
}

function selectEntryById(entries, id) {
  const entry = entries.find((item) => item.id === id || item.exportName === id);
  if (!entry) {
    throw new Error(`Entry not found: ${id}`);
  }
  return entry;
}

async function selectFromMenu({ title, items, formatItem }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive selection requires a TTY. Use --list or --entry for non-interactive usage.');
  }

  let selected = 0;
  let offset = 0;
  const pageSize = Math.max(5, Math.min(20, (process.stdout.rows || 24) - 6));

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    function render() {
      if (selected < offset) offset = selected;
      if (selected >= offset + pageSize) offset = selected - pageSize + 1;
      const visible = items.slice(offset, offset + pageSize);

      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(`${title}\n`);
      process.stdout.write('Use arrow keys, Enter to run, q/Esc to quit.\n\n');
      visible.forEach((item, idx) => {
        const absolute = offset + idx;
        const marker = absolute === selected ? '>' : ' ';
        process.stdout.write(`${marker} ${formatItem(item)}\n`);
      });
      process.stdout.write(`\n${selected + 1}/${items.length}\n`);
    }

    function cleanup(value) {
      process.stdin.setRawMode(false);
      process.stdin.off('keypress', onKey);
      process.stdout.write('\n');
      resolve(value);
    }

    function onKey(str, key = {}) {
      if (key.name === 'down') {
        selected = Math.min(items.length - 1, selected + 1);
        render();
        return;
      }
      if (key.name === 'up') {
        selected = Math.max(0, selected - 1);
        render();
        return;
      }
      if (key.name === 'pagedown') {
        selected = Math.min(items.length - 1, selected + pageSize);
        render();
        return;
      }
      if (key.name === 'pageup') {
        selected = Math.max(0, selected - pageSize);
        render();
        return;
      }
      if (key.name === 'return') {
        cleanup(items[selected]);
        return;
      }
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup(null);
      }
    }

    process.stdin.on('keypress', onKey);
    render();
  });
}

async function promptEntryArgs(entry) {
  const inputs = getEntryInputs(entry);
  if (!inputs.length) return [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const values = [];
  try {
    for (const input of inputs) {
      const suffix = input.required === false ? ' optional' : ' required';
      const type = input.type || 'unknown';
      const answer = await question(rl, `${input.name} (${type},${suffix}): `);
      if (!answer.trim() && input.required === false) {
        continue;
      }
      values.push(parseInputValue(answer, input));
    }
  } finally {
    rl.close();
  }

  return normalizeRuntimeArgs(entry, values);
}

function getEntryInputs(entry) {
  const executionParams = entry && entry.execution && Array.isArray(entry.execution.parameters)
    ? entry.execution.parameters
    : [];
  if (executionParams.length) return executionParams;
  if (entry && entry.io && Array.isArray(entry.io.inputs)) return entry.io.inputs;
  return [];
}

function normalizeRuntimeArgs(entry, values) {
  if (entry && entry.execution && entry.execution.kind === 'cli') {
    if (values.length === 1 && Array.isArray(values[0])) return values[0];
    return values.flatMap((value) => Array.isArray(value) ? value : [value]);
  }
  return values;
}

function parseInputValue(raw, input = {}) {
  const text = String(raw || '').trim();
  if (input.kind === 'option' && input.flag && input.type === 'boolean') {
    return parseBoolean(text) ? input.flag : [];
  }
  if (input.kind === 'option' && input.flag) {
    return text ? [input.flag, text] : [];
  }
  if (input.name === 'args' && input.type === 'array') {
    return text.startsWith('[') ? parseJsonInput(text) : splitArgs(text);
  }
  if (input.type === 'array') {
    return text.startsWith('[') ? parseJsonInput(text) : splitArgs(text);
  }
  if (input.type === 'object' || input.type === 'json') {
    return parseJsonInput(text);
  }
  if (input.type === 'number') {
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`Invalid number for ${input.name}`);
    return value;
  }
  if (input.type === 'boolean') {
    return parseBoolean(text);
  }
  return parseScalar(text);
}

function parseArgsJson(raw) {
  const parsed = parseJsonInput(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function parseJsonInput(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON input: ${err.message}`);
  }
}

function parseScalar(text) {
  if (text === '') return '';
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    return parseJsonInput(text);
  }
  return text;
}

function parseBoolean(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function splitArgs(text) {
  if (!text.trim()) return [];
  const args = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g;
  let match;
  while ((match = pattern.exec(text))) {
    args.push((match[1] || match[2] || match[0]).replace(/\\(["'\\])/g, '$1'));
  }
  return args;
}

function question(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function writeEntryList(entries, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }
  for (const entry of entries) {
    process.stdout.write(`${entry.id} ${formatEntryLabel(entry)}\n`);
  }
}

function writeRunResult(result, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result && Object.prototype.hasOwnProperty.call(result, 'result')) {
    if (typeof result.result === 'string') {
      process.stdout.write(result.result + '\n');
    } else {
      process.stdout.write(JSON.stringify(result.result, null, 2) + '\n');
    }
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function formatEntryLabel(entry) {
  const project = entry.__project && entry.__project.name ? entry.__project.name : path.basename(path.dirname(path.dirname(entry.__indexPath || 'mesh')));
  const kind = entry.execution && entry.execution.kind ? entry.execution.kind : 'unknown';
  return `${project} | ${entry.type} | ${kind} | ${entry.relativePath || entry.filePath} :: ${entry.exportName}`;
}

function projectName(index) {
  return index && index.project && index.project.name
    ? index.project.name
    : path.basename(path.dirname(path.dirname(index && index.path ? index.path : 'mesh')));
}

function compareString(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printHelp() {
  process.stdout.write([
    'Usage: node cli.js [root...]',
    '',
    'Interactive mesh runner for .leumas/functionIndex.json files.',
    '',
    'Options:',
    '  --roots <paths>       Path-delimited, comma, or newline separated roots',
    '  --cwd                 Scan only the current working directory instead of the current drive',
    '  --list                List callable entries without running',
    '  --entry <id|name>     Run a specific entry non-interactively',
    '  --args <json-array>   Args for --entry, for example "[1,2]"',
    '  --json                JSON output',
    '  --timeout <ms>        Execution timeout, default 30000',
    '  --mode <runner|import> Node import mode for JS functions',
    '  --help                Show help',
    '',
  ].join('\n'));
}

if (require.main === module) {
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  main().catch((err) => {
    process.stderr.write((err && err.stack) ? `${err.stack}\n` : `${String(err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  findMeshIndexFiles,
  loadMeshIndexes,
  getCallableEntries,
  parseInputValue,
  parseArgsJson,
  splitArgs,
  splitPathList,
  getCurrentDriveRoot,
  formatEntryLabel,
  main,
};
