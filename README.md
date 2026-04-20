# Leumas Function Mesh (MVP)

Barebones MVP that indexes Node.js functions and React components into `.leumas/functionIndex.json`, discovers indexes across roots, and executes allowed Node functions locally.

## Quick start

```bash
npm install leumas-function-mesh
```

Index a project:

```bash
npx leumas-mesh index
```

Discover indexes:

```bash
npx leumas-mesh discover --roots "/path/to/projects"
```

Run a function (must be marked `@mesh callable`):

```bash
npx leumas-mesh run <entryId> --args "[1,2]"
```

## Callable exports

Add `@mesh callable` to a file or create `mesh.exports.json` at the project root:

```json
{
  "exports": [
    { "file": "src/math.js", "exportName": "add" }
  ]
}
```
