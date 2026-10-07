import { parseWorkerEnvironment } from '@tsms/config';
import { createHealthServer } from './health.js';

function bootstrap() {
  const env = parseWorkerEnvironment(process.env);
  const server = createHealthServer();
  server.on('error', (error) => {
    console.error(JSON.stringify({ event: 'worker_error', message: error.message }));
    process.exitCode = 1;
  });
  server.listen(env.WORKER_HEALTH_PORT, env.WORKER_HOST, () => {
    console.info(
      JSON.stringify({
        event: 'service_started',
        service: 'tsms-worker',
        port: env.WORKER_HEALTH_PORT,
      }),
    );
  });
  const shutdown = () => {
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  bootstrap();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : 'Worker startup failed');
  process.exitCode = 1;
}
