const { indexProject } = require('./indexer/indexProject');
const { bulkIndexProjects, bulkIndexChildDirectories } = require('./indexer/bulkIndexProjects');
const { remoteIndexGitRepo, bulkRemoteIndexGitRepos } = require('./indexer/remoteIndexGitRepos');
const { discoverIndexes } = require('./discovery/discoverIndexes');
const { listMeshEntries } = require('./discovery/cache');
const { runMeshEntry } = require('./exec/runMeshEntry');
const { runNodeFunction } = require('./exec/runNodeFunction');
const { createMeshComponent } = require('./react/createMeshComponent');
const { useMeshRegistry } = require('./react/useMeshRegistry');

module.exports = {
  indexProject,
  bulkIndexProjects,
  bulkIndexChildDirectories,
  remoteIndexGitRepo,
  bulkRemoteIndexGitRepos,
  discoverIndexes,
  listMeshEntries,
  runMeshEntry,
  runNodeFunction,
  createMeshComponent,
  useMeshRegistry,
};
