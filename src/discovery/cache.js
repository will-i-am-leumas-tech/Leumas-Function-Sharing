const fs = require('fs');
const path = require('path');
const { getCachePath, getConfigDir } = require('../config/paths');

async function writeCache({ cachePath, payload }) {
  const target = cachePath || getCachePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  return target;
}

function readCache({ cachePath } = {}) {
  const target = cachePath || getCachePath();
  try {
    const raw = fs.readFileSync(target, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function listMeshEntries({ cachePath, cache } = {}) {
  const data = cache || readCache({ cachePath });
  if (!data || !Array.isArray(data.indexes)) return [];
  const entries = [];
  for (const idx of data.indexes) {
    if (idx && Array.isArray(idx.entries)) {
      entries.push(...idx.entries);
    }
  }
  return entries;
}

module.exports = { writeCache, readCache, listMeshEntries };
