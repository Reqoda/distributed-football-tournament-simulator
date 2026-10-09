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

// Reads the request body and parses it as JSON. Empty body gives {}.
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // POST /tasks
    if (req.method === 'POST' && url.pathname === '/tasks') {
      const { payload } = await readJson(req);
      if (!isValidPayload(payload)) {
        return send(res, 400, { error: 'payload must be a JSON object' });
      }
      const task = store.add(payload);
      return send(res, 201, { id: task.id });
    }

    // GET /tasks/next?worker=<name>  -> a worker asks for work (pull model).
    // Returns 204 if there is no work; the worker waits a bit and asks again.
    if (req.method === 'GET' && url.pathname === '/tasks/next') {
      const workerId = url.searchParams.get('worker');
      if (!workerId) return send(res, 400, { error: 'missing ?worker=<name>' });

      const task = store.claimNext(workerId);
      if (!task) return send(res, 204);
      return send(res, 200, task);
    }

    // GET /tasks/:id
    if (req.method === 'GET') {
      const match = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (match) {
        const task = store.get(match[1]);
        if (!task) return send(res, 404, { error: 'task not found' });
        return send(res, 200, task);
      }
    }

    // POST /tasks/:id/result
    if (req.method === 'POST') {
      const match = url.pathname.match(/^\/tasks\/([^/]+)\/result$/);
      if (match) {
        const result = await readJson(req);
        const outcome = store.complete(match[1], result);
        if (!outcome.ok) {
          if (outcome.reason === 'not_found') return send(res, 404, { error: 'task not found' });
          return send(res, 409, { error: 'task is not running' });
        }
        return send(res, 200, outcome.task);
      }
    }
    // '/tasks/next' and '/tasks/:id' can be confused with each other.
    // The order in which you check them matters.

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`coordinator listening on port ${PORT}`));
