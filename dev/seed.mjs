// A demo trip for the dev stack, so there's something to click on: four people, places in Tokyo
// (some planned, some voted on), a subgroup, expenses, a hotel, chat and shared locations.
// Runs once: if the trip already exists it does nothing.
//
//   node dev/seed.mjs [http://localhost:8080]
//
// Everyone's password is "tabitest". Kenny is the trip admin.
import WebSocket from 'ws';

const B = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');
const KEY = process.env.ACCESS_KEY || '';
const PASSWORD = 'tabitest';
const PEOPLE = ['Kenny', 'Sam', 'Mia', 'Kai'];
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('sv'); }; // YYYY-MM-DD, local
let ip = 10;

// The private-link key, when the stack has one, as a cookie on every request
let gate = '';
if (KEY) {
  const r = await fetch(`${B}/?key=${encodeURIComponent(KEY)}`, { redirect: 'manual' });
  gate = (r.headers.getSetCookie().find((c) => !c.startsWith('tabi_session')) || '').split(';')[0];
}
const post = async (path, body, cookie = '') => {
  const r = await fetch(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B, 'CF-Connecting-IP': `10.77.0.${ip++}`, Cookie: [gate, cookie].filter(Boolean).join('; ') }, body: JSON.stringify(body) });
  const session = (r.headers.getSetCookie().find((c) => c.startsWith('tabi_session')) || '').split(';')[0];
  return { status: r.status, body: await r.json().catch(() => ({})), session };
};
const status = await (await fetch(`${B}/api/status`, { headers: { Cookie: gate } })).json().catch(() => ({}));
if (status.setup) { console.log('The trip already exists: nothing to do. Start with --fresh for a new one.'); process.exit(0); }

// Kenny makes the trip; the others join with its code
const made = await post('/api/setup', { tripName: 'Tokyo (dev)', start: day(-2), end: day(10), name: 'Kenny', password: PASSWORD });
if (made.status !== 200) { console.log(made.status === 409 || /already/i.test(made.body.error || '') ? 'The trip already exists: nothing to do. Start with --fresh for a new one.' : `Couldn’t make the trip: ${made.body.error || made.status}`); process.exit(made.status === 409 ? 0 : 1); }
const sessions = { Kenny: made.session };

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(B.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: [gate, sessions[name]].filter(Boolean).join('; '), Origin: B } });
    const c = { ws, acks: new Map(), state: null, n: 0 };
    ws.on('message', (m) => { const x = JSON.parse(m); if (x.t === 'state') { c.state = x; resolve(c); } if (x.t === 'ack') c.acks.get(x.id)?.(x); });
    ws.on('error', reject);
  });
}
const op = (c, name, data) => new Promise((resolve) => {
  const id = `seed${++c.n}`;
  c.acks.set(id, (x) => { if (x.ok === false) console.log(`  (${name}: ${x.error})`); resolve(x); });
  c.ws.send(JSON.stringify({ t: 'op', id, op: name, data }));
});

const K = await connect('Kenny');
for (const name of PEOPLE.slice(1)) {
  const j = await post('/api/join', { code: K.state.trip.joinCode, name, password: PASSWORD });
  if (j.status !== 200) { console.log(`Couldn’t add ${name}: ${j.body.error || j.status}`); process.exit(1); }
  sessions[name] = j.session;
}
const C = { Kenny: K };
for (const name of PEOPLE.slice(1)) C[name] = await connect(name);
const users = (await connect('Kenny')).state.users;
const id = Object.fromEntries(users.map((u) => [u.name, u.id]));
for (const name of PEOPLE) await op(C[name], 'recovery.snooze', {});

const PLACES = [
  ['p_seed0001', 'Sensō-ji', 35.7148, 139.7967, 'Asakusa, Taitō', 'confirmed', day(0)],
  ['p_seed0002', 'Shibuya Crossing', 35.6595, 139.7005, 'Shibuya', 'confirmed', day(0)],
  ['p_seed0003', 'teamLab Planets', 35.6491, 139.7898, 'Toyosu, Kōtō', 'confirmed', day(1)],
  ['p_seed0004', 'Tsukiji Outer Market', 35.6655, 139.7707, 'Tsukiji, Chūō', 'confirmed', day(1)],
  ['p_seed0005', 'Meiji Jingu', 35.6764, 139.6993, 'Yoyogi, Shibuya', 'suggested', null],
  ['p_seed0006', 'Ichiran Shibuya', 35.6614, 139.7010, 'Shibuya', 'suggested', null],
  ['p_seed0007', 'Tokyo Skytree', 35.7101, 139.8107, 'Oshiage, Sumida', 'maybe', null],
  ['p_seed0008', 'Shinjuku Gyoen', 35.6852, 139.7101, 'Shinjuku', 'suggested', null],
];
for (const [pid, name, lat, lng, address] of PLACES) await op(K, 'place.add', { place: { id: pid, name, lat, lng, address } });
for (const [pid, , , , , st, d] of PLACES) if (st !== 'suggested') await op(K, 'place.update', { id: pid, patch: { status: st, ...(d ? { day: d } : {}) } });
await op(C.Sam, 'place.vote', { id: 'p_seed0006', value: 'up' });
await op(C.Kai, 'place.vote', { id: 'p_seed0006', value: 'up' });
await op(C.Mia, 'place.vote', { id: 'p_seed0005', value: 'up' });
await op(C.Kai, 'place.vote', { id: 'p_seed0008', value: 'down' });

await op(K, 'group.save', { group: { id: 'g_seedramen', name: 'Ramen crew', color: '#E60012', memberIds: [id.Sam, id.Kai] } });
await op(K, 'stay.save', { stay: { id: 's_seedhotel', name: 'Shinjuku hotel', address: '2-chōme Nishi-Shinjuku, Shinjuku', lat: 35.6905, lng: 139.6917, startDay: day(-2), endDay: day(9) } });

const split = (amount, who) => { const each = Math.floor(amount / who.length); return who.map((n, i) => ({ userId: id[n], amount: i === 0 ? amount - each * (who.length - 1) : each })); };
const expense = (eid, title, amount, paidBy, who, category, date) => op(C[paidBy], 'expense.save', { expense: { id: eid, kind: 'expense', title, amount, currency: 'JPY', rate: 1, paidBy: id[paidBy], date, category, splitMode: 'equal', shares: split(amount, who) } });
await expense('e_seed0001', 'Izakaya dinner', 14800, 'Kenny', PEOPLE, 'food', day(-1));
await expense('e_seed0002', 'teamLab tickets', 15200, 'Sam', ['Sam', 'Mia'], 'activities', day(0));
await expense('e_seed0003', 'Suica top-ups', 8000, 'Mia', PEOPLE, 'transport', day(-2));

await op(C.Sam, 'loc.share', { on: true });
await op(C.Mia, 'loc.share', { on: true });
await op(C.Sam, 'loc.update', { lat: 35.6598, lng: 139.7004, acc: 25 });
await op(C.Mia, 'loc.update', { lat: 35.7140, lng: 139.7960, acc: 40 });

const say = async (who, chat, text, extra = {}) => (await op(C[who], 'chat.send', { chat, text, clientId: `seed-${Math.random().toString(36).slice(2)}`, ...extra })).m;
await say('Kenny', 'trip', 'Welcome to the dev trip! Everything here is made up.');
const q = await say('Mia', 'trip', 'Sensō-ji first thing tomorrow? @Sam are you in?');
await say('Sam', 'trip', 'In. Meet at the Kaminarimon gate at 8?', { replyTo: q?.id });
if (q) await op(C.Kenny, 'chat.react', { id: q.id, emoji: '👍', on: true });
await say('Sam', 'g:g_seedramen', 'Ichiran after the crossing?');
await say('Kai', 'g:g_seedramen', 'Always 🍜');

for (const c of Object.values(C)) c.ws.close();
console.log(`Demo trip ready: sign in as ${PEOPLE.join(', ')} with the password "${PASSWORD}". Kenny is the admin.`);
process.exit(0);
