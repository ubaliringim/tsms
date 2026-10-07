import { createServer } from 'node:http';

/** Process liveness only; there is intentionally no queue connection in Stage 0. */
export function createHealthServer() {
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200);
      response.end(JSON.stringify({ status: 'ok', service: 'tsms-worker' }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ status: 'not_found' }));
  });
}
