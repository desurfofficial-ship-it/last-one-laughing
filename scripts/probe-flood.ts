/* Probe v4: rate-limit flood behavior */
import { startTestServer, makeClient } from '../server/test/harness';
import { GameState } from '../shared/src/state/schema';

process.env.LOL_TEST = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = await startTestServer();
const client = makeClient(srv.port);
const a = await client.create('arena', { name: 'Flood' }, GameState);
await sleep(300);
console.log('A token:', a.reconnectionToken);
let leftCode: number | null = null;
a.onLeave((code) => { leftCode = code; console.log('ONLEAVE code=', code); });
for (let i = 0; i < 200; i++) a.send('input', { mx: 0.1, my: 0, dash: false });
console.log('sent 200 messages');
await sleep(1500);
console.log('leftCode after 1.5s:', leftCode);
await srv.close();
process.exit(0);
