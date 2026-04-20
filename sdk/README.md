# Leumas Function Mesh SDK

JavaScript SDK for indexing projects, discovering indexes, and calling callable functions across apps.

## Install

```bash
npm install leumas-function-mesh-sdk
```

Or from this repo:

```bash
npm install ./sdk
```

## API

```js
const {
  createIndex,
  findAllIndex,
  callFunctionInIndex,
  indexStats,
  bulkIndexStatus,
} = require('leumas-function-mesh-sdk');
```

### `createIndex(path, options?)`

Creates `.leumas/functionIndex.json` for a project and returns `{ path, index }`.

Function entries include `io` metadata:
- `io.inputs`: array of `{ name, type, required, description }`
- `io.output`: `{ type, description }`

If JSDoc is present, types/descriptions are extracted. Otherwise, SDK falls back to parameter names with `type: "unknown"`.

Example:

```js
const created = await createIndex('/apps/a');
const add = created.index.entries.find((e) => e.exportName === 'add');
console.log(add.io);
```

### `findAllIndex(path)`

Finds all `.leumas/functionIndex.json` files under a root path.

### `callFunctionInIndex(options)`

Call a callable function in an index by `entryId` or `exportName`.

```js
await callFunctionInIndex({
  indexPath: '/apps/a/.leumas/functionIndex.json',
  exportName: 'add',
  args: [2, 3],
  mode: 'import',
});
```

Use `entry.io.inputs` to build the args in order.

### `indexStats(path)`

Returns aggregate index stats for one project or a root containing many projects.

### `bulkIndexStatus(paths, options?)`

Fast bulk status check for many app paths.

Returns whether each path has `.leumas/`, whether it has `.leumas/functionIndex.json`, and includes project metadata/stats when index exists.

```js
const statuses = await bulkIndexStatus(
  ['/apps/a', '/apps/b', '/apps/c'],
  { concurrency: 64 }
);
```
