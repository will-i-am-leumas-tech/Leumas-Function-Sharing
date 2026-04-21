#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { loadMeshIndexes, getCallableEntries, getCurrentDriveRoot } = require('./cli');
const { runMeshEntry } = require('./src/exec/runMeshEntry');
const { normalizeRuntimePath } = require('./src/shared/runtimePaths');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(__dirname, 'assets');
const DEFAULT_PORT = 7412;

function createServer(options = {}) {
  const publicDir = options.publicDir || PUBLIC_DIR;

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (url.pathname === '/api/health') {
        sendJson(res, { ok: true });
        return;
      }

      if (url.pathname === '/api/entries' && req.method === 'GET') {
        const root = resolveRoot(url.searchParams.get('root'));
        const indexes = await loadMeshIndexes({ roots: [root] });
        const entries = getCallableEntries(indexes);
        sendJson(res, {
          ok: true,
          root,
          indexes: indexes.length,
          entries,
        });
        return;
      }

      if (url.pathname === '/api/run' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const root = resolveRoot(body.root);
        const indexes = await loadMeshIndexes({ roots: [root] });
        const entries = getCallableEntries(indexes);
        const entry = entries.find((item) => item.id === body.entryId);

        if (!entry) {
          sendJson(res, { ok: false, error: 'Entry not found' }, 404);
          return;
        }

        const result = await runMeshEntry({
          entry,
          args: Array.isArray(body.args) ? body.args : [],
          mode: body.mode || 'runner',
          timeoutMs: Number(body.timeoutMs) || 30000,
        });
        sendJson(res, result);
        return;
      }

      if (url.pathname.startsWith('/assets/')) {
        await serveStatic(ASSETS_DIR, url.pathname.replace(/^\/assets/, '') || '/', res);
        return;
      }

      await serveStatic(publicDir, url.pathname, res);
    } catch (err) {
      sendJson(res, { ok: false, error: err && err.message ? err.message : String(err) }, 500);
    }
  });
}

function resolveRoot(input) {
  const raw = input && String(input).trim()
    ? String(input).trim()
    : getCurrentDriveRoot(process.cwd());
  return path.resolve(normalizeRuntimePath(raw));
}

async function serveStatic(publicDir, pathname, res) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDir, `.${decodeURIComponent(requestedPath)}`);
  const publicRoot = path.resolve(publicDir);

  if (!filePath.startsWith(publicRoot + path.sep) && filePath !== publicRoot) {
    sendText(res, 'Not found', 404, 'text/plain; charset=utf-8');
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      sendText(res, 'Not found', 404, 'text/plain; charset=utf-8');
      return;
    }
    const content = await fs.promises.readFile(filePath);
    sendBuffer(res, content, getContentType(filePath));
  } catch (err) {
    sendText(res, 'Not found', 404, 'text/plain; charset=utf-8');
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, payload, statusCode = 200) {
  sendText(res, JSON.stringify(payload, null, 2), statusCode, 'application/json; charset=utf-8');
}

function sendText(res, text, statusCode = 200, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendBuffer(res, buffer, contentType) {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || DEFAULT_PORT);
  const host = options.host || process.env.HOST || '127.0.0.1';
  const server = createServer(options);

  server.listen(port, host, () => {
    process.stdout.write(`Leumas Mesh UI running at http://${host}:${port}/\n`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  startServer,
  resolveRoot,
};
