const fs = require('fs');
const os = require('os');
const path = require('path');

function getConfigDir() {
  const homeDir = os.homedir();
  if (isWritableDirectory(homeDir)) {
    return path.join(homeDir, '.leumas');
  }
  return path.join(os.tmpdir(), '.leumas');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'mesh.config.json');
}

function getCachePath() {
  return path.join(getConfigDir(), 'mesh.cache.json');
}

function isWritableDirectory(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = { getConfigDir, getConfigPath, getCachePath };
