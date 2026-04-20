# SDK Usage (Local Install + Minimal Examples)

This project includes a standalone JavaScript SDK in `./sdk`.

## 1. Install locally in another app

From your target app directory:

```bash
npm install /mnt/d/leumas/npm/leumas-function-sharing/sdk
```

## 2. Import the SDK

```js
const {
  createIndex,
  findAllIndex,
  callFunctionInIndex,
  indexStats,
  bulkIndexStatus,
} = require('leumas-function-mesh-sdk');
```

## 3. `createIndex(path)`

Create `.leumas/functionIndex.json` for an app:

```js
const created = await createIndex('/absolute/path/to/app-a');
console.log(created.path); // /absolute/path/to/app-a/.leumas/functionIndex.json
console.log(created.index.entries.length);
const add = created.index.entries.find((e) => e.exportName === 'add');
console.log(add.io); // { inputs: [...], output: {...} }
```

`io` is included for function-like entries and defines expected inputs and output:
- `io.inputs`: `[{ name, type, required, description }]`
- `io.output`: `{ type, description }`

## 4. `findAllIndex(path)`

Discover all indexes under a shared root:

```js
const indexes = await findAllIndex('/absolute/path/to/projects-root');
console.log(indexes.map((i) => i.path));
```

## 5. `callFunctionInIndex(...props)`

Call a callable function from an index.

Using `exportName`:

```js
const result = await callFunctionInIndex({
  indexPath: '/absolute/path/to/app-a/.leumas/functionIndex.json',
  exportName: 'add',
  args: [2, 3],
  mode: 'import',
});

console.log(result); // { ok: true, result: 5 }
```

Minimal way to build args from contract:

```js
const index = created.index;
const addEntry = index.entries.find((e) => e.exportName === 'add');
console.log(addEntry.io.inputs); // use this as your input field definition
```

Using `entryId`:

```js
const result = await callFunctionInIndex({
  indexPath: '/absolute/path/to/app-a/.leumas/functionIndex.json',
  entryId: 'ENTRY_ID_FROM_INDEX',
  args: ['hello'],
});
```

## 6. `indexStats(path)`

Get aggregate stats for one app or many apps:

```js
const stats = await indexStats('/absolute/path/to/projects-root');
console.log(stats.totals);
console.log(stats.projects);
```

## 7. `bulkIndexStatus(paths, options?)`

Fast status check for a large list of app paths.

```js
const statuses = await bulkIndexStatus(
  [
    '/absolute/path/to/app-a',
    '/absolute/path/to/app-b',
    '/absolute/path/to/app-c',
  ],
  { concurrency: 64 }
);

console.log(statuses);
```

Each result includes:
- `hasLeumasDir`: whether `.leumas/` exists
- `hasIndexFile`: whether `.leumas/functionIndex.json` exists
- `project`, `summary`, `stats`: populated when index exists

## Complete minimal flow

```js
const {
  createIndex,
  findAllIndex,
  callFunctionInIndex,
  indexStats,
  bulkIndexStatus,
} = require('leumas-function-mesh-sdk');

async function main() {
  const appA = '/absolute/path/to/app-a';
  const appB = '/absolute/path/to/app-b';
  const root = '/absolute/path/to';

  // 1) Each app announces its functions
  await createIndex(appA);
  await createIndex(appB);

  // 2) Discover all app indexes
  const all = await findAllIndex(root);
  console.log('Found indexes:', all.length);

  // 3) Call function from app A
  const res = await callFunctionInIndex({
    indexPath: `${appA}/.leumas/functionIndex.json`,
    exportName: 'add',
    args: [10, 32],
    mode: 'import',
  });
  console.log('Call result:', res);

  // 4) View mesh stats
  const stats = await indexStats(root);
  console.log('Stats:', stats.totals);

  // 5) Quickly check many app paths
  const scan = await bulkIndexStatus([appA, appB], { concurrency: 64 });
  console.log('Bulk status:', scan);
}

main().catch(console.error);
```

## Important note

A function must be marked callable to run through the SDK.

Example:

```js
// @mesh callable
export function add(a, b) {
  return a + b;
}
```

Or define callable exports in `mesh.exports.json` at your app root.

For clearly typed inputs/outputs, add JSDoc above exports:

```js
/**
 * @param {number} a first value
 * @param {number} b second value
 * @returns {number} sum
 */
export function add(a, b) {
  return a + b;
}
```
