/**
 * Entry point: `npm run start -w server` (or `tsx src/index.ts`).
 * PORT env overrides the default 8787.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app';

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const port = Number(process.env.PORT ?? 8787);
  const app = createApp();
  app.httpServer.listen(port, () => {
    console.log(`[lol-server] listening on http://0.0.0.0:${port} (ws path /ws, testMode=${app.testMode})`);
  });
}
