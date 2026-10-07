import { parseApiEnvironment } from '@tsms/config';
import { createApplication } from './application.js';

async function bootstrap() {
  const env = parseApiEnvironment(process.env);
  const app = await createApplication();
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, env.API_HOST);
  console.info(
    JSON.stringify({ event: 'service_started', service: 'tsms-api', port: env.API_PORT }),
  );
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API startup failed');
  process.exitCode = 1;
});
