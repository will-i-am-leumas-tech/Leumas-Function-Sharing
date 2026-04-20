const fs = require('fs');
const path = require('path');
const { getConfigDir, getConfigPath } = require('./paths');

function splitRoots(envValue) {
  if (!envValue) return [];
  return envValue
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

function loadConfig() {
  const envRoots = splitRoots(process.env.LEUMAS_MESH_ROOTS);
  const configPath = getConfigPath();
  let fileRoots = [];

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.roots)) {
      fileRoots = parsed.roots.filter((r) => typeof r === 'string');
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      throw err;
    }
  }

  return {
    roots: Array.from(new Set([...envRoots, ...fileRoots])),
    configDir: getConfigDir(),
    configPath,
  };
}

module.exports = { loadConfig };
