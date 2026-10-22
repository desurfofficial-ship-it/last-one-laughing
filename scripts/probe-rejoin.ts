/* Probe v3: reconnection token availability + flow */
import { startTestServer, makeClient } from '../server/test/harness';
import { GameState } from '../shared/src/state/schema';

process.env.LOL_TEST = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = await startTestServer();
const client = makeClient(srv.port);
const a = await client.create('arena', { name: 'Ada' }, GameState);
await sleep(300);
console.log('A reconnectionToken=', a.reconnectionToken, 'sessionId=', a.sessionId);

const b = await client.joinById(a.state.code, { name: 'Basil' }, GameState);
await sleep(300);
console.log('B reconnectionToken=', b.reconnectionToken, 'sessionId=', b.sessionId);

// find own row via sid? (checking field exists)
console.log('B own row:', [...b.state.players.values()].map((p: any) => `${p.pid}:${p.name}:sid=${p.sid}`));

b.connection.close();
await sleep(300);
console.log('A sees B present:', [...a.state.players.values()].map((p: any) => `${p.pid}:${p.present}`));

try {
  const b2 = await client.reconnect(b.reconnectionToken, GameState);
  await sleep(200);
  console.log('REJOINED. sessionId=', b2.sessionId);
  console.log('A sees B present after rejoin:', [...a.state.players.values()].map((p: any) => `${p.pid}:${p.present}`));
  b2.leave().catch(() => {});
} catch (err) {
  console.log('RECONNECT FAILED:', (err as Error).message);
}
await sleep(200);
await srv.close();
process.exit(0);
