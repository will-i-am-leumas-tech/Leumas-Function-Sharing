const fs = require('fs');
const path = require('path');

async function writeIndex({ outFile, index }) {
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const tmpPath = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8');
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
  return outFile;
}

module.exports = { writeIndex };
