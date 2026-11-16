// Friends: everyone in the trip, where they are, what they're doing today, and money between you.
import { state, on, emit, userById, groupsOn, today, tripDays, defaultDay, personDayStops } from './store.js';
import { openSheet, esc, icon, avatar, ago, distanceM, fmtDay } from './ui.js';
import { myPosition } from './location.js';

const STALE = 15 * 60e3;
let listSheet = null;
let friendSheet = null;

export function friendStatus(u) {
  const loc = state.locations[u.id];
  if (loc) return { loc, fresh: Date.now() - loc.ts < STALE, text: `${Date.now() - loc.ts < STALE ? 'Live' : 'Last seen'} ${ago(loc.ts)}` };
  if (u.shareLocation) return { text: 'Sharing, no update yet' };
  return { text: 'Not sharing location' };
}
const distanceText = (loc) => {
  const me = myPosition();
  if (!me || !loc) return '';
  const d = distanceM(me, loc);
  return d < 1000 ? `${Math.round(d / 10) * 10} m away` : `${(d / 1000).toFixed(d < 10000 ? 1 : 0)} km away`;
};
const groupToday = (id) => groupsOn(today()).find((g) => g.memberIds.includes(+id));

['locations', 'users', 'subgroups', 'expenses', 'places', 'mypos'].forEach((e) => on(e, () => {
  if (listSheet && !listSheet.closed) renderList();
  if (friendSheet && !friendSheet.closed) renderFriend();
}));

// ---------- list ----------
export function openFriends() {
  listSheet = openSheet({ title: 'Friends', sub: 'Tap someone to see where they are, their plan, and money between you.' });
  renderList();
}

function renderList() {
  const others = state.users.filter((u) => u.id !== state.me?.id).map((u) => ({ u, st: friendStatus(u) }))
    .sort((a, b) => (b.st.loc?.ts || 0) - (a.st.loc?.ts || 0) || a.u.name.localeCompare(b.u.name));
  const live = others.filter((x) => x.st.loc);
  listSheet.body.innerHTML = `
    ${live.length > 1 ? `<button class="btn block" data-all style="margin-bottom:12px">${icon('fit')}Show everyone on the map</button>` : ''}
    <div class="card" style="margin:0;border:1px solid var(--line)">
      ${others.map(({ u, st }) => {
        const g = groupToday(u.id);
        return `<button class="row friend-row-item" data-friend="${u.id}">
          <span class="friend-av">${avatar(u)}<span class="dot ${st.loc ? (st.fresh ? 'live' : 'stale') : ''}"></span></span>
          <span class="grow"><span class="label">${esc(u.name)}</span>${g ? ` <span class="group-tag" style="--g:${esc(g.color)}">${esc(g.name)}</span>` : ''}
            <span class="help">${esc(st.text)}${st.loc && distanceText(st.loc) ? `, ${distanceText(st.loc)}` : ''}</span></span>
          ${icon('chevron-right')}</button>`;
      }).join('') || '<div class="row help">Nobody else has joined yet. Invite friends from Settings.</div>'}
    </div>`;
  listSheet.body.querySelectorAll('[data-friend]').forEach((b) => b.onclick = () => { listSheet.close(); openFriend(+b.dataset.friend, { pinpoint: true }); });
  listSheet.body.querySelector('[data-all]')?.addEventListener('click', () => { listSheet.close(); emit('fit-friends'); });
}

// ---------- one friend ----------
let currentId = null;
export function openFriend(id, { pinpoint = false } = {}) {
  const u = userById(id);
  if (!u) return;
  currentId = +id;
  if (friendSheet && !friendSheet.closed) friendSheet.close();
  friendSheet = openSheet({ peek: true, className: 'friend-sheet', onClose: () => { currentId = null; } });
  renderFriend().then(() => { if (pinpoint && state.locations[id]) requestAnimationFrame(() => emit('focus-friend', +id)); });
}

async function renderFriend() {
  const u = userById(currentId);
  if (!u) return friendSheet?.close();
  const st = friendStatus(u);
  const g = groupToday(u.id);
  const loc = st.loc;
  friendSheet.setHead(`<div style="display:flex;gap:12px;align-items:center" class="grow">${avatar(u, 'big')}
    <div><h2>${esc(u.name)}</h2><div class="sub">${g ? `In <span class="group-tag" style="--g:${esc(g.color)}">${esc(g.name)}</span> today` : 'With the main group today'}</div></div></div>`);

  // Their plan for today (or the nearest trip day)
  const days = tripDays();
  const day = days.includes(today()) ? today() : defaultDay();
  const stops = day ? personDayStops(day, u.id) : [];
  const next = stops.find((s) => s.state === 'todo');

  // Money between you (lazy: money.js is only loaded when needed)
  const { ledger, fmt } = await import('./money.js');
  if (currentId !== u.id) return;
  const owes = ledger().pair(u.id, state.me?.id); // > 0: they owe you
  const shared = [...state.expenses.values()].filter((e) => (e.paidBy === state.me?.id && e.shares.some((x) => x.userId === u.id)) || (e.paidBy === u.id && e.shares.some((x) => x.userId === state.me?.id))).length;

  friendSheet.body.innerHTML = `
    <section class="friend-section">
      <h3>${icon('pin', 'small')} Location</h3>
      ${loc ? `
        <p><b>${esc(st.text)}</b>${loc.source === 'owntracks' ? ' via OwnTracks' : loc.source === 'app' ? ' from the app' : ''}</p>
        <p class="help">${[loc.acc ? `Accurate to about ${Math.round(loc.acc)} m` : '', loc.batt != null ? `battery ${loc.batt}%` : '', distanceText(loc)].filter(Boolean).join(', ')}</p>
        ${!st.fresh ? `<p class="help">This is where they were ${ago(loc.ts)}. They may have moved since.</p>` : ''}
        <div class="links" style="margin-bottom:0">
          <button class="btn primary" data-pin>${icon('locate')}Pinpoint</button>
          <a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}&travelmode=walking" target="_blank" rel="noopener">${icon('walk')}Walk there</a>
        </div>`
      : `<p class="help">${u.shareLocation ? `${esc(u.name)} has sharing on, but their phone hasn’t sent a location yet.` : `${esc(u.name)} isn’t sharing their location.`}</p>`}
    </section>

    <section class="friend-section">
      <h3>${icon('calendar', 'small')} ${day ? `Plan for ${day === today() ? 'today' : esc(fmtDay(day))}` : 'Plan'}</h3>
      ${stops.length ? `<div class="mini-plan">${stops.slice(0, 5).map((s, i) => `<button class="mini-stop" data-place="${s.place.id}">
          <span class="station sm" data-state="${s.state === 'todo' ? (s === next ? 'next' : '') : s.state}">${s.state === 'visited' ? '✓' : i + 1}</span>
          <span class="grow">${esc(s.place.name)}</span><span class="help num">${esc(s.place.time || '')}</span></button>`).join('')}
          ${stops.length > 5 ? `<p class="help">and ${stops.length - 5} more</p>` : ''}</div>`
        : `<p class="help">No confirmed stops for them ${day === today() ? 'today' : 'on this day'}.</p>`}
      <button class="btn block" data-itin>${icon('calendar')}See ${esc(u.name)}’s itinerary</button>
    </section>

    <section class="friend-section">
      <h3>${icon('yen', 'small')} Money</h3>
      <p><b class="${owes > 0 ? 'pos' : owes < 0 ? 'neg' : ''}">${owes > 0 ? `${esc(u.name)} owes you ${fmt(owes)}` : owes < 0 ? `You owe ${esc(u.name)} ${fmt(-owes)}` : 'You’re all square'}</b></p>
      <p class="help">${shared ? `${shared} expense${shared === 1 ? '' : 's'} between you` : 'No shared expenses yet'}</p>
      <div class="links" style="margin-bottom:0">
        <button class="btn" data-money>${icon('yen')}Expenses together</button>
        ${owes ? `<button class="btn primary" data-settle>${owes > 0 ? 'Record payment' : 'Settle up'}</button>` : ''}
      </div>
    </section>`;

  const b = friendSheet.body;
  const toMap = () => { if (document.getElementById('screen-map').hidden) emit('go', 'map'); };
  b.querySelector('[data-pin]')?.addEventListener('click', () => { toMap(); emit('focus-friend', u.id); });
  b.querySelector('[data-itin]').onclick = () => { friendSheet.close(); emit('itin-person', u.id); emit('go', 'itinerary'); };
  b.querySelector('[data-money]').onclick = () => { friendSheet.close(); emit('money-with', u.id); emit('go', 'money'); };
  b.querySelector('[data-settle]')?.addEventListener('click', async () => {
    const { openPayment } = await import('./money.js');
    const me = state.me.id;
    openPayment(owes > 0 ? { from: u.id, to: me, amount: owes } : { from: me, to: u.id, amount: -owes });
  });
  b.querySelectorAll('[data-place]').forEach((x) => x.onclick = () => { toMap(); emit('focus-place', x.dataset.place); });
}

