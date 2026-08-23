import { fileURLToPath } from 'node:url';

const localEnvFile = process.env.SHIFENG_LOCAL_ENV_FILE
  || fileURLToPath(new URL('./.env.local', import.meta.url));

try {
  process.loadEnvFile(localEnvFile);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await import('./server/index.js');
