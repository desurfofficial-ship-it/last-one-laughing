/* Probe v2: when does room.state populate, and do patches flow afterwards? */
import { startTestServer, makeClient } from '../server/test/harness';
import { GameState } from '../shared/src/state/schema';

process.env.LOL_TEST = '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const srv = await startTestServer();
const client = makeClient(srv.port);

const a = await client.create('arena', { name: 'Ada' }, GameState);
let aPatches = 0;
a.onStateChange(() => aPatches++);
const dump = (label: string, room: any) =>
  console.log(label, 'code=', room.state?.code, 'players=', room.state?.players ? [...room.state.players.values()].map((p: any) => `${p.pid}:${p.name}`) : 'NO MAP');

dump('A@join', a);
await sleep(300);
dump('A@300ms', a);

const code = a.state?.code;
console.log('A patches so far:', aPatches);
if (code) {
  const b = await client.joinById(code, { name: 'Basil' }, GameState);
  dump('B@join', b);
  await sleep(600);
  dump('A@+600ms after B join', a);
  console.log('A patches total:', aPatches);
  const got: unknown[] = [];
  a.onMessage('welcome', (w: unknown) => got.push(w));
  const c = await client.joinById(code, { name: 'Cleo' }, GameState);
  await sleep(300);
  console.log('late welcome handler got:', JSON.stringify(got));
  dump('C@+300ms', c);
  dump('A@final', a);
} else {
  console.log('state never populated - investigating');
}
await srv.close();
process.exit(0);
