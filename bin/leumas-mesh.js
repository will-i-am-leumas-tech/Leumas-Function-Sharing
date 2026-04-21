#!/usr/bin/env node

const path = require('path');
const { indexProject } = require('../src/indexer/indexProject');
const { bulkIndexProjects, bulkIndexChildDirectories } = require('../src/indexer/bulkIndexProjects');
const { bulkRemoteIndexGitRepos } = require('../src/indexer/remoteIndexGitRepos');
const { discoverIndexes } = require('../src/discovery/discoverIndexes');
const { listMeshEntries, readCache } = require('../src/discovery/cache');
const { runMeshEntry } = require('../src/exec/runMeshEntry');

const BOOLEAN_OPTIONS = new Set(['json', 'keep-clone', 'include-hidden', 'include-ignored', 'help', 'h']);
const VALUE_OPTIONS = new Set(['roots', 'urls', 'repos', 'out', 'output', 'clone-root', 'ref', 'concurrency', 'args', 'mode', 'parent', 'dir', 'root']);

function parseArgs(argv) {
  const args = { _: [] };
  let currentKey = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      const key = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
      const value = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
      if (value !== undefined) {
        args[key] = value;
        currentKey = null;
      } else if (BOOLEAN_OPTIONS.has(key)) {
        args[key] = true;
        currentKey = null;
      } else {
        args[key] = true;
        currentKey = VALUE_OPTIONS.has(key) ? key : null;
      }
    } else if (currentKey) {
      args[currentKey] = arg;
      currentKey = null;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (command === 'index') {
    if (args.roots) {
      const roots = parsePathList(args.roots);
      const result = await bulkIndexProjects(roots, { concurrency: args.concurrency });
      writeBulkIndexResult(result, Boolean(args.json));
      if (result.totals.failed > 0) process.exitCode = 1;
      return;
    }
    const rootDir = args._[1] ? path.resolve(args._[1]) : process.cwd();
    const outFile = args.out ? path.resolve(args.out) : undefined;
    await indexProject({ rootDir, outFile });
    process.stdout.write('Indexed project\n');
    return;
  }

  if (command === 'bulk-index') {
    const roots = [
      ...args._.slice(1),
      ...(args.roots ? parsePathList(args.roots) : []),
    ];
    if (!roots.length) {
      throw new Error('Missing project directories. Use `leumas-mesh bulk-index <dir...>` or `--roots`.');
    }
    const result = await bulkIndexProjects(roots, { concurrency: args.concurrency });
    writeBulkIndexResult(result, Boolean(args.json));
    if (result.totals.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === 'bulk-index-children' || command === 'index-children') {
    const parentDir = args._[1] || args.parent || args.dir || args.root;
    if (!parentDir) {
      throw new Error('Missing parent directory. Use `leumas-mesh bulk-index-children <parent-dir>`.');
    }
    const result = await bulkIndexChildDirectories(parentDir, {
      concurrency: args.concurrency,
      includeHidden: Boolean(args['include-hidden']),
      includeIgnored: Boolean(args['include-ignored']),
    });
    writeBulkIndexResult(result, Boolean(args.json));
    if (result.totals.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === 'remote-index') {
    const urls = [
      ...args._.slice(1),
      ...(args.urls ? parseUrlList(args.urls) : []),
      ...(args.repos ? parseUrlList(args.repos) : []),
    ];
    if (!urls.length) {
      throw new Error('Missing Git URLs. Use `leumas-mesh remote-index <git-url...>` or `--urls`.');
    }
    const result = await bulkRemoteIndexGitRepos(urls, {
      outputDir: args.out ? path.resolve(args.out) : (args.output ? path.resolve(args.output) : undefined),
      cloneRoot: args['clone-root'] ? path.resolve(args['clone-root']) : undefined,
      keepClone: Boolean(args['keep-clone']),
      ref: typeof args.ref === 'string' ? args.ref : undefined,
      concurrency: args.concurrency,
    });
    writeRemoteIndexResult(result, Boolean(args.json));
    if (result.totals.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === 'discover') {
    const roots = args.roots ? args.roots.split(path.delimiter) : undefined;
    await discoverIndexes({ roots });
    process.stdout.write('Discovery cache updated\n');
    return;
  }

  if (command === 'run') {
    const entryId = args._[1];
    if (!entryId) {
      throw new Error('Missing entryId');
    }
    const cache = readCache();
    const registry = listMeshEntries({ cache });
    const parsedArgs = args.args ? JSON.parse(args.args) : [];
    const result = await runMeshEntry({ entryId, registry, args: parsedArgs, mode: args.mode || 'runner' });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stdout.write('Usage: leumas-mesh <index|bulk-index|bulk-index-children|remote-index|discover|run>\n');
}

function parsePathList(raw) {
  return String(raw || '')
    .split(new RegExp(`[${escapeRegExp(path.delimiter)},\\n\\r]+`))
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseUrlList(raw) {
  return String(raw || '')
    .split(/[\n\r,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function writeBulkIndexResult(result, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stdout.write(`Indexed ${result.totals.ok}/${result.totals.projects} projects`);
  process.stdout.write(` (${result.totals.entries} entries, ${result.totals.callable} callable)\n`);
  if (result.parentPath) {
    process.stdout.write(`Parent: ${result.parentPath}\n`);
  }
  for (const item of result.results) {
    if (item.ok) {
      const name = item.project && item.project.name ? item.project.name : path.basename(item.path);
      process.stdout.write(`ok ${name} ${item.entries} entries -> ${item.indexPath}\n`);
    } else {
      process.stdout.write(`fail ${item.path}: ${item.error}\n`);
    }
  }
}

function writeRemoteIndexResult(result, asJson) {
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  process.stdout.write(`Indexed ${result.totals.ok}/${result.totals.repositories} remote repositories`);
  process.stdout.write(` (${result.totals.entries} entries, ${result.totals.callable} callable)\n`);
  process.stdout.write(`Output: ${result.outputDir}\n`);
  for (const item of result.results) {
    if (item.ok) {
      const name = item.project && item.project.name ? item.project.name : item.repoSlug;
      process.stdout.write(`ok ${name} ${item.entries} entries -> ${item.indexPath}\n`);
    } else {
      process.stdout.write(`fail ${item.gitUrl}: ${item.error}\n`);
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main().catch((err) => {
  process.stderr.write((err && err.stack) ? err.stack : String(err));
  process.exitCode = 1;
});
