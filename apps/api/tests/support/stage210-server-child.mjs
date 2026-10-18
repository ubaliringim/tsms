// A real API process for the Stage 2.10.1 shutdown tests.
//
// It boots the COMPILED application (the same `createApplication` the service uses), listens on an ephemeral loopback
// port, and reports its address over IPC. It then waits for a `close` message, which runs the same `app.close()` that
// Nest's shutdown hooks run on SIGTERM, so a graceful stop can be tested on every platform (on Windows a signal cannot
// run handlers, it simply terminates the process). A hard stop is the parent killing the process.
//
// Configuration arrives as JSON in STAGE210_CHILD_CONFIG so no secret is placed on a command line. The guarded test
// database and Redis URLs are validated by the parent before they are passed here.

import { createApplication } from '../../dist/application.js';

const config = JSON.parse(process.env.STAGE210_CHILD_CONFIG ?? '{}');
const app = await createApplication({
  ...config,
  NODE_ENV: 'test',
  API_HOST: '127.0.0.1',
  API_PORT: 4000,
});
await app.listen(0, '127.0.0.1');
process.send?.({ type: 'listening', url: await app.getUrl() });

process.on('message', async (message) => {
  if (message !== 'close') return;
  try {
    await app.close();
    process.send?.({ type: 'closed' });
  } finally {
    process.exit(0);
  }
});
