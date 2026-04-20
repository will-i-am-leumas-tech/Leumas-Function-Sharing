#!/usr/bin/env node

const path = require('path');
const { indexProject } = require('../src/indexer/indexProject');
const { discoverIndexes } = require('../src/discovery/discoverIndexes');
const { listMeshEntries, readCache } = require('../src/discovery/cache');
const { runMeshEntry } = require('../src/exec/runMeshEntry');

function parseArgs(argv) {
  const args = { _: [] };
  let currentKey = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      currentKey = arg.slice(2);
      args[currentKey] = true;
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
    const rootDir = args._[1] ? path.resolve(args._[1]) : process.cwd();
    const outFile = args.out ? path.resolve(args.out) : undefined;
    await indexProject({ rootDir, outFile });
    process.stdout.write('Indexed project\n');
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

  process.stdout.write('Usage: leumas-mesh <index|discover|run>\n');
}

main().catch((err) => {
  process.stderr.write((err && err.stack) ? err.stack : String(err));
  process.exitCode = 1;
});
