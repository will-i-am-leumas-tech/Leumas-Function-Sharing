const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  createIndex,
  bulkCreateIndexes,
  remoteCreateIndex,
  bulkRemoteCreateIndexes,
  findAllIndex,
  callFunctionInIndex,
  indexStats,
  bulkIndexStatus,
} = require('../src/index');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function hasPython() {
  return ['python3', 'python'].some((command) => {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    return result.status === 0;
  });
}

function hasGit() {
  return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
}

function createGitRepo(rootDir, name, filePath, content) {
  const repoDir = path.join(rootDir, name);
  fs.mkdirSync(repoDir, { recursive: true });
  git(['init'], repoDir);
  writeFile(path.join(repoDir, filePath), content);
  git(['add', '.'], repoDir);
  git(['-c', 'user.email=mesh@example.test', '-c', 'user.name=Mesh Test', 'commit', '-m', 'init'], repoDir);
  return repoDir;
}

test('createIndex writes index and returns entries', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-create-'));

  writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'app-one', version: '1.0.0' }, null, 2));
  writeFile(path.join(projectDir, 'src', 'math.mjs'), '// @mesh callable\nexport function add(a, b) { return a + b; }\n');

  const result = await createIndex(projectDir);
  const addEntry = result.index.entries.find((entry) => entry.exportName === 'add');

  assert.ok(fs.existsSync(result.path));
  assert.equal(result.index.project.name, 'app-one');
  assert.ok(addEntry);
  assert.ok(Array.isArray(addEntry.io.inputs));
  assert.equal(addEntry.io.output.type, 'string | number');
});

test('findAllIndex discovers indexes under a root', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-find-'));
  const appA = path.join(rootDir, 'app-a');
  const appB = path.join(rootDir, 'app-b');

  writeFile(path.join(appA, 'src', 'a.mjs'), '// @mesh callable\nexport function one() { return 1; }\n');
  writeFile(path.join(appB, 'src', 'b.mjs'), '// @mesh callable\nexport function two() { return 2; }\n');

  await createIndex(appA);
  await createIndex(appB);

  const indexes = await findAllIndex(rootDir);
  assert.equal(indexes.length, 2);
});

test('bulkCreateIndexes creates indexes for many project directories', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-bulk-create-'));
  const appA = path.join(rootDir, 'app-a');
  const appB = path.join(rootDir, 'app-b');

  writeFile(path.join(appA, 'src', 'a.mjs'), '// @mesh callable\nexport function one() { return 1; }\n');
  writeFile(path.join(appB, 'scripts', 'echo.js'), 'console.log(process.argv[2] || "");\n');

  const result = await bulkCreateIndexes([appA, appB], { concurrency: 2 });
  const byPath = new Map(result.results.map((item) => [item.path, item]));

  assert.equal(result.concurrency, 2);
  assert.equal(result.totals.projects, 2);
  assert.equal(result.totals.ok, 2);
  assert.equal(result.totals.failed, 0);
  assert.equal(fs.existsSync(path.join(appA, '.leumas', 'functionIndex.json')), true);
  assert.equal(fs.existsSync(path.join(appB, '.leumas', 'cli.json')), true);
  assert.equal(byPath.get(path.resolve(appA)).ok, true);
  assert.equal(byPath.get(path.resolve(appB)).ok, true);
});

test('bulkCreateIndexes reports per-project failures by default', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-bulk-fail-'));
  const appA = path.join(rootDir, 'app-a');
  const missing = path.join(rootDir, 'missing');

  writeFile(path.join(appA, 'src', 'a.mjs'), '// @mesh callable\nexport function one() { return 1; }\n');

  const result = await bulkCreateIndexes([appA, missing], { concurrency: 2 });

  assert.equal(result.totals.projects, 2);
  assert.equal(result.totals.ok, 1);
  assert.equal(result.totals.failed, 1);
  assert.equal(result.results.find((item) => item.path === path.resolve(missing)).ok, false);
});

test('remoteCreateIndex clones and indexes a git repository', { skip: !hasGit() }, async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-remote-'));
  const repoDir = createGitRepo(
    rootDir,
    'remote-app',
    path.join('src', 'math.mjs'),
    '// @mesh callable\nexport function add(a, b) { return a + b; }\n'
  );
  const outputDir = path.join(rootDir, 'indexes');

  const result = await remoteCreateIndex(repoDir, { outputDir });

  assert.equal(result.ok, true);
  assert.equal(result.entries, 1);
  assert.equal(result.callable, 1);
  assert.ok(result.indexPath.startsWith(outputDir));
  assert.equal(fs.existsSync(result.indexPath), true);
});

test('bulkRemoteCreateIndexes indexes many git repositories', { skip: !hasGit() }, async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-remote-bulk-'));
  const repoA = createGitRepo(rootDir, 'remote-a', path.join('src', 'a.mjs'), '// @mesh callable\nexport function one() { return 1; }\n');
  const repoB = createGitRepo(rootDir, 'remote-b', path.join('scripts', 'echo.js'), 'console.log(process.argv[2] || "");\n');
  const outputDir = path.join(rootDir, 'indexes');

  const result = await bulkRemoteCreateIndexes([repoA, repoB], { outputDir, concurrency: 2 });

  assert.equal(result.totals.repositories, 2);
  assert.equal(result.totals.ok, 2);
  assert.equal(result.totals.failed, 0);
  assert.ok(result.totals.entries >= 2);
  assert.equal(result.results.every((item) => fs.existsSync(item.indexPath)), true);
});

test('callFunctionInIndex executes callable export', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-call-'));
  writeFile(path.join(projectDir, 'src', 'ops.mjs'), '// @mesh callable\nexport function multiply(a, b) { return a * b; }\n');

  const created = await createIndex(projectDir);
  const output = await callFunctionInIndex({
    index: created.index,
    exportName: 'multiply',
    args: [6, 7],
    mode: 'import',
  });

  assert.equal(output.ok, true);
  assert.equal(output.result, 42);
});

test('callFunctionInIndex executes callable Python export', { skip: !hasPython() }, async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-python-call-'));
  writeFile(
    path.join(projectDir, 'pyproject.toml'),
    [
      '[project]',
      'name = "sdk-python-demo"',
      'version = "1.2.0"',
      '',
    ].join('\n')
  );
  writeFile(
    path.join(projectDir, 'src', 'ops.py'),
    [
      '# @mesh callable',
      'def add(a: int, b: int) -> int:',
      '    return a + b',
      '',
    ].join('\n')
  );

  const created = await createIndex(projectDir);
  const addEntry = created.index.entries.find((entry) => entry.exportName === 'add');
  const output = await callFunctionInIndex({
    index: created.index,
    exportName: 'add',
    args: [10, 5],
  });

  assert.equal(created.index.project.name, 'sdk-python-demo');
  assert.equal(addEntry.type, 'python_function');
  assert.equal(addEntry.io.inputs[0].type, 'number');
  assert.equal(output.ok, true);
  assert.equal(output.result, 15);
});

test('indexStats returns aggregate totals', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-stats-'));
  const appA = path.join(rootDir, 'app-a');
  const appB = path.join(rootDir, 'app-b');

  writeFile(path.join(appA, 'src', 'api.mjs'), '// @mesh callable\nexport function ping() { return "pong"; }\n');
  writeFile(path.join(appB, 'src', 'ui.jsx'), 'export function Badge() { return <div>ok</div>; }\n');

  await createIndex(appA);
  await createIndex(appB);

  const stats = await indexStats(rootDir);

  assert.equal(stats.totals.indexes, 2);
  assert.ok(stats.totals.entries >= 2);
  assert.ok(stats.totals.callable >= 1);
});

test('bulkIndexStatus reports .leumas/index status and stats for many paths', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-bulk-'));
  const appA = path.join(rootDir, 'app-a');
  const appB = path.join(rootDir, 'app-b');
  const appC = path.join(rootDir, 'app-c');

  writeFile(path.join(appA, 'src', 'math.mjs'), '// @mesh callable\nexport function add(a, b) { return a + b; }\n');
  writeFile(path.join(appB, 'placeholder.txt'), 'no index yet\n');
  writeFile(path.join(appC, '.leumas', 'note.txt'), 'folder exists but no index\n');

  await createIndex(appA);

  const statuses = await bulkIndexStatus([appA, appB, appC], { concurrency: 32 });
  const byPath = new Map(statuses.map((item) => [item.path, item]));

  const a = byPath.get(path.resolve(appA));
  assert.equal(a.hasLeumasDir, true);
  assert.equal(a.hasIndexFile, true);
  assert.equal(a.project.name, path.basename(appA));
  assert.ok(a.stats.total >= 1);

  const b = byPath.get(path.resolve(appB));
  assert.equal(b.hasLeumasDir, false);
  assert.equal(b.hasIndexFile, false);
  assert.equal(b.stats, null);

  const c = byPath.get(path.resolve(appC));
  assert.equal(c.hasLeumasDir, true);
  assert.equal(c.hasIndexFile, false);
});

test('createIndex captures JSDoc input/output contracts', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-contract-'));
  writeFile(
    path.join(projectDir, 'src', 'calc.mjs'),
    [
      '// @mesh callable',
      '/**',
      ' * Adds two numbers.',
      ' * @param {number} a first value',
      ' * @param {number} b second value',
      ' * @returns {number} sum',
      ' */',
      'export function add(a, b) { return a + b; }',
      '',
    ].join('\n')
  );

  const created = await createIndex(projectDir);
  const addEntry = created.index.entries.find((entry) => entry.exportName === 'add');

  assert.ok(addEntry);
  assert.equal(addEntry.io.inputs.length, 2);
  assert.equal(addEntry.io.inputs[0].name, 'a');
  assert.equal(addEntry.io.inputs[0].type, 'number');
  assert.equal(addEntry.io.output.type, 'number');
});

test('findAllIndex normalizes io for legacy indexes without io field', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-legacy-'));
  const appDir = path.join(rootDir, 'legacy-app');
  const indexDir = path.join(appDir, '.leumas');
  const indexPath = path.join(indexDir, 'functionIndex.json');

  fs.mkdirSync(indexDir, { recursive: true });
  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      {
        project: { name: 'legacy-app', version: '1.0.0', rootPath: appDir, createdAt: new Date().toISOString() },
        entries: [
          {
            id: 'abc123',
            type: 'node_function',
            exportName: 'add',
            signature: '(a, b)',
            callable: true,
            execution: { kind: 'import', modulePath: '/tmp/legacy/add.mjs', exportName: 'add' },
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const indexes = await findAllIndex(rootDir);
  assert.equal(indexes.length, 1);
  const entry = indexes[0].entries[0];
  assert.ok(entry.io);
  assert.equal(entry.io.inputs.length, 2);
  assert.equal(entry.io.inputs[0].name, 'a');
  assert.equal(entry.io.output.type, 'unknown');
});

test('createIndex includes io contract for util exports as empty contract', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-util-'));
  writeFile(path.join(projectDir, 'src', 'constants.mjs'), 'export const VERSION = \"1.0.0\";\n');

  const created = await createIndex(projectDir);
  const versionEntry = created.index.entries.find((entry) => entry.exportName === 'VERSION');

  assert.ok(versionEntry);
  assert.equal(versionEntry.type, 'util');
  assert.ok(versionEntry.io);
  assert.deepEqual(versionEntry.io.inputs, []);
  assert.equal(versionEntry.io.output.type, 'unknown');
});

test('createIndex infers object input schema and object output schema', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-sdk-schema-'));
  writeFile(
    path.join(projectDir, 'src', 'schema.mjs'),
    [
      '// @mesh callable',
      'export function run({ userId, limit = 10, filters = {} }) {',
      '  return { ok: true, count: limit, filters };',
      '}',
      '',
    ].join('\n')
  );

  const created = await createIndex(projectDir);
  const runEntry = created.index.entries.find((entry) => entry.exportName === 'run');

  assert.ok(runEntry);
  assert.equal(runEntry.io.inputs.length, 1);
  assert.equal(runEntry.io.inputs[0].type, 'object');
  assert.ok(runEntry.io.inputs[0].schema.userId);
  assert.equal(runEntry.io.inputs[0].schema.limit.type, 'number');
  assert.equal(runEntry.io.inputs[0].schema.limit.required, false);
  assert.equal(runEntry.io.output.type, 'object');
  assert.ok(runEntry.io.output.schema.ok);
});
