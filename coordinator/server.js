// coordinator/server.js: HTTP API that hands tasks out to workers.
// Run: node coordinator/server.js   (or: npm run coordinator)
const http = require('node:http');
const store = require('./store');
const { isValidPayload } = require('../shared/task');

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 1024 * 1024; // refuse bodies larger than 1 MB

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

// An error the client caused (400). Anything without a status is our bug (500).
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Reads the request body and parses it as JSON. Empty body gives {}.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(badRequest('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(badRequest('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // POST /tasks
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const { payload } = await readJson(req);
      if (!isValidPayload(payload)) {
        return send(res, 400, { error: 'payload must be a JSON object' });
      }
      const task = await store.add(payload);
      return send(res, 201, { id: task.id });
    }

    // POST /tasks/claim?worker=<name>
    // returns 204 if there is no work, the worker waits a bit and asks again.
    if (req.method === 'POST' && url.pathname === '/tasks/claim') {
      const workerId = url.searchParams.get('worker');
      if (!workerId) return send(res, 400, { error: 'missing ?worker=<name>' });

      const task = await store.claimNext(workerId);
      if (!task) return send(res, 204);
      return send(res, 200, task);
    }

    // GET /tasks/:id
    if (req.method === 'GET') {
      const match = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (match) {
        const task = await store.get(match[1]);
        if (!task) return send(res, 404, { error: 'task not found' });
        return send(res, 200, task);
      }
    }

    // POST /tasks/:id/result?worker=<name>
    if (req.method === 'POST') {
      const match = url.pathname.match(/^\/tasks\/([^/]+)\/result$/);
      const workerId = url.searchParams.get('worker');

      if (match) {
        if (!workerId) return send(res, 400, { error: 'missing ?worker=<name>' });
        const result = await readJson(req);
        const outcome = await store.complete(match[1], workerId, result);
        if (!outcome.ok) {
          if (outcome.reason === 'not_found') return send(res, 404, { error: 'task not found' });
          if (outcome.reason === 'not_running') return send(res, 409, { error: 'task is not running' });
          if (outcome.reason === 'not_owner') return send(res, 409, { error: `task is no longer owned by worker: ${workerId}` });
          console.error('unexpected result from store.complete:', outcome.reason);
          return send(res, 500, { error: 'internal server error' });
        }
        return send(res, 200, outcome.task);
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    if (err.status === 400) return send(res, 400, { error: err.message });
    console.error('unexpected error:', err);
    send(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () =>
  console.log(`coordinator listening on port ${PORT} (store: ${store.name})`)
);