/* Probe v5: sid matching */
import { startTestServer, makeClient } from '../server/test/harness';
import { GameState } from '../shared/src/state/schema';

process.env.LOL_TEST = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const srv = await startTestServer();
const client = makeClient(srv.port);
const a = await client.create('arena', { name: 'Ada' }, GameState);
await sleep(400);
console.log('client sessionId:', a.sessionId);
for (const [k, p] of a.state.players as any) {
  console.log(`row key=${k} pid=${p.pid} sid=${JSON.stringify(p.sid)} name=${p.name}`);
}
const b = await client.joinById(a.state.code, { name: 'Basil' }, GameState);
await sleep(400);
console.log('B sessionId:', b.sessionId);
for (const [k, p] of b.state.players as any) {
  console.log(`B row key=${k} pid=${p.pid} sid=${JSON.stringify(p.sid)}`);
}
await srv.close();
process.exit(0);
