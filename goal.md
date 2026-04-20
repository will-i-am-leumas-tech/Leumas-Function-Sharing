# goal.md — Leumas Function Mesh (npm package)

## 0) One‑sentence summary

Build an npm package that **indexes all Node.js functions + React components inside any project**, saves a portable **functionIndex.json**, and provides a **local discovery + execution layer** so any app on the same machine can find and run exported functions/components from other projects.

> Mental model: a **local “function/component registry”** that every project can publish to and consume from.

---

## 1) What we’re aiming to do (plain English)

When a project installs this package:

1. On startup (or via CLI), it **scans the project folder**, finds functions/components/hooks/helpers, and writes a **standard index JSON** describing what exists.
2. It also runs a **local discovery scan** across the machine to find other projects’ index JSON files.
3. It exposes APIs to:

   * List all discovered functions/components.
   * **Execute Node functions** from another project (safe, controlled execution).
   * **Load React components** from another project (as a React wrapper component or dynamic import contract).

End result: all apps “shout” their exported capabilities into a shared registry, and any app can “listen” and reuse them.

---

## 2) MVP constraints (keep it buildable in one Codex swing)

* Support **Node.js 20+**.
* React support is **client-side consumption** via:

  * a registry + metadata + import path contract (no magical cross-bundler runtime), and
  * an optional **Vite plugin** (or generic bundler helper) for smoother dynamic imports.
* Node execution is done via a **local runner service** (child_process) or direct dynamic import when allowed.
* Start with **same-machine only** (no networking).

---

## 3) Deliverables

### A) npm package

Name (placeholder): `leumas-function-mesh`

* Works in Node runtime and provides React helpers.
* Ships with:

  * CLI to index a project
  * discovery scanner
  * execution helpers
  * optional lightweight local registry server (HTTP) (MVP can be file-based only)

### B) Demo apps

* `demo-node/` showing indexing + discovering + executing a function from another demo project.
* `demo-react/` showing discovery + listing + rendering a component from another project using the import-path contract.

### C) Tests

* Unit tests for indexing output normalization.
* Unit tests for discovery.
* Integration test: index 2 demo projects then execute across them.

---

## 4) Architecture overview

### 4.1 Index format (standardized)

Each project writes to one of:

* `./.leumas/functionIndex.json` (recommended)
* or `./functionIndex.json` (fallback)

Index includes:

* project metadata: name, version, rootPath, createdAt
* list of entries:

  * type: `node_function | react_component | react_hook | util | unknown`
  * id: stable hash (path + exportName)
  * filePath (absolute + relative)
  * exportName
  * signature (best effort)
  * tags (component/hook/etc.)
  * runtime: `node | browser | both`
  * execution:

    * for node functions: `{ kind: "import", modulePath, exportName }` or `{ kind: "runner", entry }`
    * for react components: `{ kind: "module", modulePath, exportName }`

### 4.2 Indexing strategy

* Reuse the spirit of your FunctionIndexer2:

  * resilient parsing
  * extract exports
  * detect React components via heuristics:

    * file extension `.jsx/.tsx`
    * `function Name()` returning JSX
    * `const Name = () => (<div />)`
    * default export component
* For MVP: index only these file types:

  * Node: `.js,.cjs,.mjs`
  * React: `.jsx,.tsx` (tsx indexing can be metadata-only unless TS parser added)

### 4.3 Discovery strategy

Find all index files on the machine.
MVP approach:

* Discover from a **configured set of roots** (fast):

  * env: `LEUMAS_MESH_ROOTS="D:\\Leumas;D:\\Projects"` (Windows example)
  * or config file: `~/.leumas/mesh.config.json`
* Scan those roots recursively for `/.leumas/functionIndex.json`.
* Cache results in `~/.leumas/mesh.cache.json` with timestamps.

### 4.4 Execution strategy

#### Node function execution (MVP)

Provide two modes:

1. **Direct import mode** (fast, same Node version):

   * `await import(modulePath)` then call `mod[exportName](...args)`
2. **Runner mode** (safer/isolated):

   * Spawn a child process with a small runner script:

     * loads module by path
     * calls export with JSON args
     * returns JSON result

Important: MVP must include a **denylist** or explicit allowlist:

* Only run functions explicitly marked “callable” via:

  * JSDoc tag `@mesh callable`
  * or export from a `mesh.exports.js` file

#### React component “execution” (MVP)

You can’t truly execute a React component across separate builds without a contract.
MVP contract:

* Consumer app imports remote component module path **at build-time** (bundler can include it) OR uses Vite aliasing.
* Provide helpers:

  * `createMeshComponent({ modulePath, exportName })` => returns a React component that lazy-loads.
* Optional Vite plugin:

  * resolves discovered module paths into aliases so the app can `import("mesh:<id>")`.

---

## 5) Public API design (what developers will use)

### Node APIs

* `indexProject({ rootDir, outFile })`
* `discoverIndexes({ roots })`
* `listMeshEntries({ cache })`
* `runNodeFunction({ entryId, args, mode })`

### React APIs

* `useMeshRegistry()` hook that loads discovery cache and returns entries
* `MeshBrowser` component (optional) that lists entries and filters
* `createMeshComponent({ entryId })` / `MeshComponent({ entryId, props })`

### CLI

* `leumas-mesh index [rootDir]`
* `leumas-mesh discover --roots "..."`
* `leumas-mesh run <entryId> --args '{"x":1}'`

---

## 6) File tree (package)

```
leumas-function-mesh/
  package.json
  README.md
  LICENSE
  tsconfig.json                 # optional; can be JS-only for MVP
  src/
    index.js                     # main exports
    config/
      loadConfig.js              # reads ~/.leumas/mesh.config.json and env
      paths.js                   # OS-safe path helpers
    indexer/
      indexProject.js            # project indexing entry
      detectReact.js             # heuristics for react components
      detectExports.js           # exports parsing helpers
      writeIndex.js              # writes .leumas/functionIndex.json
      schema.js                  # json schema + validation
    discovery/
      discoverIndexes.js         # scan roots for index files
      cache.js                   # cache read/write
    exec/
      runNodeFunction.js         # direct import + runner mode
      runner/
        runner.js                # child process worker
    react/
      createMeshComponent.jsx    # lazy module loader wrapper
      useMeshRegistry.js         # hook to load discovery cache
      MeshBrowser.jsx            # optional UI
    shared/
      hashId.js
      logger.js
      errors.js
  bin/
    leumas-mesh.js               # CLI entry
  demo-node/
    package.json
    server.js
    helpers/
      math.js
    scripts/
      demoSetup.js               # indexes itself + another demo
  demo-react/
    package.json
    vite.config.js
    src/
      main.jsx
      App.jsx
      components/
        LocalWidget.jsx
  demo-shared-lib/
    package.json
    src/
      Button.jsx                 # “remote” component to load
      add.js                     # callable node function example
  tests/
    indexer.test.js
    discovery.test.js
    exec.test.js
```

---

## 7) Implementation checklist

### 7.1 Indexer

* [ ] Walk files under `rootDir` with ignore rules: `node_modules, dist, build, .git, coverage`.
* [ ] For each file, parse best-effort:

  * Node JS: acorn
  * JSX: acorn + jsx plugin (or fallback heuristic scanning for `export` patterns)
* [ ] Extract exports:

  * `export function X`, `export const X`, `module.exports`, `exports.X`
* [ ] Detect React components:

  * export name is PascalCase AND file is jsx/tsx OR contains JSX return
* [ ] Emit JSON index conforming to schema.

### 7.2 Discovery

* [ ] Load roots from env/config.
* [ ] Scan roots for `/.leumas/functionIndex.json`.
* [ ] Normalize paths and merge into a single registry list.
* [ ] Cache results.

### 7.3 Execution

* [ ] Implement `runNodeFunction`:

  * allowlist only
  * JSON arg passing
  * supports sync/async
  * handles errors with structured result
* [ ] Implement runner child process mode.

### 7.4 React

* [ ] `useMeshRegistry` loads cached discovery results.
* [ ] `createMeshComponent` uses `React.lazy(() => import(modulePath))`.
* [ ] Provide clear docs for Vite aliasing (MVP).

---

## 8) Security + guardrails (MVP)

Because this package can execute code, it MUST ship with guardrails:

* Default: **no functions are executable**.
* Only execute exports explicitly marked callable:

  * JSDoc `@mesh callable` OR `mesh.exports.json` manifest.
* Runner mode is the default (isolation).
* Max execution time (timeout) for runner.
* Max stdout size.

---

## 9) Local developer workflow

### Install

* `npm i leumas-function-mesh`

### In any Node project

* Add to startup:

  * `await indexProject({ rootDir: process.cwd() })`
  * `await discoverIndexes()`
* Execute:

  * `await runNodeFunction({ entryId, args: [1,2] })`

### In any React project

* Add:

  * `const { entries } = useMeshRegistry()`
  * `const RemoteComp = createMeshComponent({ entryId })`

---

## 10) Acceptance criteria

* Running `leumas-mesh index` in each demo project produces `./.leumas/functionIndex.json`.
* Running `leumas-mesh discover` finds both demo indexes and writes cache.
* `demo-node` can execute a callable function from `demo-shared-lib` and receive a JSON result.
* `demo-react` can list discovered React components and render `demo-shared-lib/Button.jsx` via `createMeshComponent` using the documented import-path contract.
* Tests pass with `npm test`.

---

## 11) Notes for Codex

* Keep it JS-first for MVP (TypeScript optional).
* Prioritize correctness + clear boundaries over “magic”.
* Make discovery root paths configurable.
* Keep React loading simple and document limitations.
