const { indexProject } = require('./indexer/indexProject');
const { discoverIndexes } = require('./discovery/discoverIndexes');
const { listMeshEntries } = require('./discovery/cache');
const { runMeshEntry } = require('./exec/runMeshEntry');
const { runNodeFunction } = require('./exec/runNodeFunction');
const { createMeshComponent } = require('./react/createMeshComponent');
const { useMeshRegistry } = require('./react/useMeshRegistry');

module.exports = {
  indexProject,
  discoverIndexes,
  listMeshEntries,
  runMeshEntry,
  runNodeFunction,
  createMeshComponent,
  useMeshRegistry,
};
