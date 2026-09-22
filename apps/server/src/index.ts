import { loadConfig } from './config';
import { startServer } from './main';

const server = await startServer(loadConfig());

const shutdown = (): void => {
  server.stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
