# Leumas Function Mesh

Indexes JavaScript, React, Python, and runnable command files into `.leumas/functionIndex.json`, discovers indexes across roots, and executes explicitly allowed local functions or commands.

## Quick start

```bash
npm install leumas-function-mesh
```

Index a project:

```bash
npx leumas-mesh index
```

This writes `.leumas/functionIndex.json` plus execution-kind sidecar indexes such as `.leumas/import.json`, `.leumas/module.json`, `.leumas/python_import.json`, or `.leumas/cli.json` when those execution kinds exist. `.leumas/executionIndex.json` lists the generated sidecar files.

Runnable entries include an absolute `execution.callCommand`, so they can be launched from outside the project directory. Batch files are indexed with `cmd.exe /d /s /c <absolute-file>`, shell scripts with either their absolute executable path or `/bin/sh <absolute-file>`, and `.exe` files with their absolute path.

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
- Runnable files such as shell scripts, batch files, PowerShell scripts, `.exe` files, and extensionless executable/shebang files
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
