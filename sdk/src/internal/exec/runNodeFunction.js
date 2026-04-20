const { runMeshEntry } = require('./runMeshEntry');

async function runNodeFunction({ entryId, entry, registry, args = [], mode = 'runner', timeoutMs = 5000 } = {}) {
  return runMeshEntry({ entryId, entry, registry, args, mode, timeoutMs });
}

module.exports = { runNodeFunction };
