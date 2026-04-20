const { indexProject } = require('./indexer/indexProject');
const { discoverIndexes } = require('./discovery/discoverIndexes');
const { listMeshEntries } = require('./discovery/cache');
const { runNodeFunction } = require('./exec/runNodeFunction');
const { createMeshComponent } = require('./react/createMeshComponent');
const { useMeshRegistry } = require('./react/useMeshRegistry');

module.exports = {
  indexProject,
  discoverIndexes,
  listMeshEntries,
  runNodeFunction,
  createMeshComponent,
  useMeshRegistry,
};
