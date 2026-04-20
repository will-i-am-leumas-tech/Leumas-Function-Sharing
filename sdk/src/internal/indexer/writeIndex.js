const fs = require('fs');
const path = require('path');

const EXECUTION_INDEX_MANIFEST = 'executionIndex.json';

async function writeIndex({ outFile, index }) {
  const outDir = path.dirname(outFile);
  await fs.promises.mkdir(outDir, { recursive: true });
  await writeJsonAtomic(outFile, index);
  await writeExecutionTypeIndexes({ outDir, mainIndexFile: outFile, index });
  return outFile;
}

async function writeJsonAtomic(outFile, payload) {
  const tmpPath = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await fs.promises.rename(tmpPath, outFile);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EEXIST')) {
      try {
        await fs.promises.rename(tmpPath, outFile);
      } catch (renameErr) {
        await fs.promises.copyFile(tmpPath, outFile);
        await fs.promises.unlink(tmpPath);
      }
    } else {
      throw err;
    }
  }
}

async function writeExecutionTypeIndexes({ outDir, mainIndexFile, index }) {
  const groups = groupEntriesByExecutionKind(index && index.entries);
  const currentFiles = new Set();
  const files = [];

  for (const [kind, entries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fileName = `${safeFileName(kind)}.json`;
    const outFile = path.join(outDir, fileName);
    currentFiles.add(fileName);
    files.push({ kind, file: fileName, count: entries.length });
    await writeJsonAtomic(outFile, {
      project: index.project || null,
      execution: {
        kind,
        count: entries.length,
      },
      generatedFrom: path.basename(mainIndexFile),
      entries,
    });
  }

  await removeStaleExecutionTypeIndexes({ outDir, currentFiles });
  await writeJsonAtomic(path.join(outDir, EXECUTION_INDEX_MANIFEST), {
    project: index.project || null,
    generatedFrom: path.basename(mainIndexFile),
    files,
  });
}

function groupEntriesByExecutionKind(entries) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const kind = entry && entry.execution && typeof entry.execution.kind === 'string'
      ? entry.execution.kind
      : null;
    if (!kind) continue;
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(entry);
  }

  for (const groupEntries of groups.values()) {
    groupEntries.sort(compareEntries);
  }

  return groups;
}

async function removeStaleExecutionTypeIndexes({ outDir, currentFiles }) {
  const manifestPath = path.join(outDir, EXECUTION_INDEX_MANIFEST);
  let oldManifest;
  try {
    oldManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (err) {
    return;
  }

  const oldFiles = Array.isArray(oldManifest.files) ? oldManifest.files : [];
  for (const item of oldFiles) {
    const fileName = item && typeof item.file === 'string' ? item.file : null;
    if (!fileName || currentFiles.has(fileName)) continue;
    if (fileName.includes('/') || fileName.includes('\\')) continue;
    try {
      await fs.promises.unlink(path.join(outDir, fileName));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
}

function compareEntries(a, b) {
  return compareString(a.relativePath, b.relativePath)
    || compareString(a.exportName, b.exportName)
    || compareString(a.type, b.type)
    || compareString(a.id, b.id);
}

function compareString(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function safeFileName(kind) {
  return String(kind || 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unknown';
}

module.exports = { writeIndex, groupEntriesByExecutionKind };
