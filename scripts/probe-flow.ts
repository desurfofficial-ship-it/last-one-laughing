/* Probe v6: replicate exact test flow */
import { startTestServer, makeClient } from '../server/test/harness';
import { GameState } from '../shared/src/state/schema';

process.env.LOL_TEST = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => any, label: string, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timeout: ' + label);
    await sleep(25);
  }
};

const srv = await startTestServer();
const client = makeClient(srv.port);

const aRaw = await client.create('arena', { name: 'Ada' }, GameState);
console.log('1. create resolved. sessionId=', aRaw.sessionId);
const row = await waitFor(() => {
  for (const p of (aRaw.state.players as any).values()) if (p.sid === aRaw.sessionId) return p;
  return null;
}, 'A own row');
console.log('2. A own row found:', row.pid, row.name, 'code=', aRaw.state.code);

const bRaw = await client.joinById(aRaw.state.code, { name: 'Basil' }, GameState);
const brow = await waitFor(() => {
  for (const p of (bRaw.state.players as any).values()) if (p.sid === bRaw.sessionId) return p;
  return null;
}, 'B own row');
console.log('3. B own row found:', brow.pid);

await waitFor(() => (aRaw.state.players as any).size === 2, 'A sees 2 players');
console.log('4. A sees 2 players');

// sequential ready with confirmation gap (avoid cross-socket race)
aRaw.send('ready', true);
await sleep(150);
bRaw.send('ready', true);
await sleep(150);
aRaw.send('start');
await waitFor(() => aRaw.state.phase === 'playing', 'playing phase', 9000);
console.log('5. playing phase reached on A');
console.log('6. A reconnectionToken=', aRaw.reconnectionToken);
await srv.close();
process.exit(0);
