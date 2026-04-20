# Leumas Function Mesh

Indexes JavaScript, React, and Python projects into `.leumas/functionIndex.json`, discovers indexes across roots, and executes explicitly allowed local functions.

## Quick start

```bash
npm install leumas-function-mesh
```

Index a project:

```bash
npx leumas-mesh index
```

This writes `.leumas/functionIndex.json` plus execution-kind sidecar indexes such as `.leumas/import.json`, `.leumas/module.json`, `.leumas/python_import.json`, or `.leumas/cli.json` when those execution kinds exist. `.leumas/executionIndex.json` lists the generated sidecar files.

Discover indexes:

```bash
npx leumas-mesh discover --roots "/path/to/projects"
```

Run a function (must be marked `@mesh callable`):

```bash
npx leumas-mesh run <entryId> --args "[1,2]"
```

## Supported entries

- JavaScript/Node functions from `.js`, `.mjs`, `.cjs`, `.jsx`, and `.tsx`
- React components and hooks
- Python functions and classes from `.py`
- Python projects with `pyproject.toml`, `requirements.txt`, package folders, or plain scripts

## Callable exports

Add `@mesh callable` to a file or create `mesh.exports.json` at the project root.

JavaScript:

```js
// @mesh callable
export function add(a, b) {
  return a + b;
}
```

Python:

```python
# @mesh callable
def add(a: int, b: int) -> int:
    return a + b
```

Manifest:

```json
{
  "exports": [
    { "file": "src/math.js", "exportName": "add" },
    { "file": "src/math.py", "exportName": "add" }
  ]
}
```

## Python notes

Python indexing uses the standard-library `ast` module through `python3` or `python`. Type hints, defaults, docstrings, async functions, classes, and package-relative imports are supported for common repository layouts.

Set `LEUMAS_PYTHON_BIN=/path/to/python` if a project needs a specific interpreter or virtual environment.
