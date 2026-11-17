// Notifications: who gets told about what, stored per person, pushed live over the WebSocket.

// Each kind is a switch in Settings. `admin` kinds are only offered to trip admins.
export const NOTIFY_KINDS = {
  groups: { default: true },     // added to or taken out of a subgroup, a subgroup you're in changes or ends
  expenses: { default: true },   // an expense you're part of is added, changed or deleted
  payments: { default: true },   // someone records a payment to or from you
  myPlaces: { default: true },   // a place you added is confirmed, vetoed or removed
  plan: { default: true },       // a confirmed stop in your plan is added, moved or dropped
  people: { default: true },     // someone joins; you're made an admin
  newPlaces: { default: false }, // anyone adds or imports places
  removed: { default: true, admin: true }, // someone removes a place (it goes to Previously interested)
  help: { default: true, admin: true },    // someone can't sign in and asks for a password reset link
  reactions: { default: true },            // someone sends you an emoji (👋)
  photos: { default: true },               // picture a day: someone adds one, or the evening reminder
  // Always on, not shown in Settings: changes to your own account's password or recovery code.
  security: { default: true, locked: true },
};

const COALESCE_MS = 15 * 60e3;
const KEEP_PER_USER = 200;

export function prefsOf(user) {
  let saved = {};
  try { saved = JSON.parse(user?.notify_prefs || '{}') || {}; } catch { /* bad JSON: defaults */ }
  const out = {};
  for (const [k, v] of Object.entries(NOTIFY_KINDS)) out[k] = !v.locked && typeof saved[k] === 'boolean' ? saved[k] : v.default;
  return out;
}

export function cleanPrefs(input, current) {
  const out = { ...current };
  for (const [k, v] of Object.entries(NOTIFY_KINDS)) if (!v.locked && typeof input?.[k] === 'boolean') out[k] = input[k];
  return out;
}

const rowOut = (r) => ({
  id: r.id, kind: r.kind, text: r.text, actorId: r.actor_id, ref: r.ref_type ? { type: r.ref_type, id: r.ref_id } : null,
  count: r.count, ts: r.created_at, read: !!r.read_at,
});

export function createNotifier({ db, deliver, now = Date.now }) {
  const users = () => db.prepare('SELECT id, is_admin, notify_prefs FROM users WHERE removed_at IS NULL').all();

  /**
   * Tell people about something.
   * recipients: [{ userId, kinds: ['myPlaces', 'plan'], text, merge }] — the first kind the person has
   *   switched on decides whether (and as what) they're told. text is a string, a function of the
   *   count when repeats are merged (merge: 'count'), or an object with one of those per kind.
   */
  function notify(recipients, { actorId = null, ref = null } = {}) {
    const byId = new Map(users().map((u) => [u.id, u]));
    const seen = new Set();
    for (const r of recipients) {
      const u = byId.get(+r.userId);
      if (!u || u.id === actorId || seen.has(u.id)) continue;
      const prefs = prefsOf(u);
      const kind = r.kinds.find((k) => NOTIFY_KINDS[k] && prefs[k] && (!NOTIFY_KINDS[k].admin || u.is_admin));
      if (!kind) continue;
      seen.add(u.id);
      const ts = now();
      const t = r.text && typeof r.text === 'object' ? r.text[kind] : r.text;
      const textFor = (n) => String(typeof t === 'function' ? t(n) : t).slice(0, 300);
      const prev = ref && db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND kind = ? AND ref_type IS ? AND ref_id IS ? AND actor_id IS ?
        AND read_at IS NULL AND created_at > ? ORDER BY id DESC LIMIT 1`).get(u.id, kind, ref.type, ref.id == null ? null : String(ref.id), actorId, ts - COALESCE_MS);
      let id;
      if (prev) {
        const count = prev.count + (r.merge === 'count' ? 1 : 0);
        db.prepare('UPDATE notifications SET text = ?, count = ?, created_at = ? WHERE id = ?').run(textFor(count), count, ts, prev.id);
        id = prev.id;
      } else {
        id = Number(db.prepare('INSERT INTO notifications(user_id, kind, text, actor_id, ref_type, ref_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(u.id, kind, textFor(1), actorId, ref?.type ?? null, ref?.id == null ? null : String(ref.id), ts).lastInsertRowid);
        db.prepare('DELETE FROM notifications WHERE user_id = ? AND id <= (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)')
          .run(u.id, u.id, KEEP_PER_USER);
      }
      deliver(u.id, rowOut(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id)), unread(u.id));
    }
  }

  const list = (userId, limit = 60) => db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(userId, limit).map(rowOut);
  const unread = (userId) => db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;

  function markRead(userId, ids) {
    if (Array.isArray(ids)) {
      const st = db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL');
      for (const id of ids.slice(0, 500)) st.run(now(), userId, +id);
    } else db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), userId);
    return unread(userId);
  }
  const clear = (userId) => db.prepare('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL').run(userId);
  const clearAll = (userId) => db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
  function dismiss(userId, ids) {
    const st = db.prepare('DELETE FROM notifications WHERE user_id = ? AND id = ?');
    for (const id of ids.slice(0, 500)) st.run(userId, +id);
  }
  // Paging back through the list. The list is ordered by time, and a notification that's updated
  // (repeats merged into it) keeps its id but moves to the top, so the cursor is (time, id).
  const older = (userId, before, limit = 40) => (typeof before === 'object' && before
    ? db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(userId, before.ts, before.ts, before.id, limit)
    : db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(userId, before, limit) // apps from 1.6
  ).map(rowOut);
  const purgeOld = () => db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?').run(now() - 45 * 864e5);

  return { notify, list, unread, markRead, clear, clearAll, dismiss, older, purgeOld };
}
