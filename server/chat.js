// Group chat: one chat for the whole trip ("trip"), and one for each subgroup ("g:<id>") that only
// its members can see. Messages are text, photos, GIFs (from KLIPY, or uploaded) and replies, with
// emoji reactions. Delivered over the existing WebSocket; notifications (and lock-screen pushes)
// for @mentions and replies by default, or for every message if someone switches that on.
export const CHAT_RATE = 30;            // messages a minute per person
export const CHAT_TEXT_MAX = 2000;

const preview = (m) => (m.kind === 'photo' ? `📷 ${m.text || 'Photo'}` : m.kind === 'gif' ? 'GIF' : String(m.text || '')).replace(/\s+/g, ' ').slice(0, 120);
// KLIPY's media hosts (GIFs are shown straight from KLIPY, as its terms require)
export const isKlipyMedia = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /^static\d*\.klipy\.com$/.test(x.hostname); } catch { return false; } };

export function createChat({ db, now = Date.now, nameOf, activeUsers, membersOf, subgroupName, sendToUsers, notifier, isReaction, viewersOf, log = () => {} }) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { expose: true }); };

  // ---- who can see what ----
  function members(chat) {
    if (chat === 'trip') return activeUsers().map((u) => u.id);
    const m = /^g:([\w-]{6,64})$/.exec(chat || '');
    if (!m || !subgroupName(m[1])) return [];
    const active = new Set(activeUsers().map((u) => u.id));
    return membersOf(m[1]).filter((id) => active.has(id));
  }
  const canSee = (userId, chat) => members(chat).includes(userId);
  const chatName = (chat) => (chat === 'trip' ? 'Everyone' : subgroupName(chat.slice(2)) || 'Subgroup');

  const reactionsOf = (ids) => {
    const out = {};
    if (!ids.length) return out;
    for (const r of db.prepare(`SELECT message_id, user_id, emoji FROM chat_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      ((out[r.message_id] ||= {})[r.emoji] ||= []).push(r.user_id);
    }
    return out;
  };
  const rowOut = (r, reacts = {}) => r.deleted_at
    ? { id: r.id, chat: r.chat, by: r.user_id, kind: 'deleted', at: r.created_at, replyTo: r.reply_to, clientId: r.client_id }
    : {
      id: r.id, chat: r.chat, by: r.user_id, kind: r.kind, text: r.text || '', replyTo: r.reply_to, at: r.created_at, clientId: r.client_id,
      mentions: r.mentions ? JSON.parse(r.mentions) : [],
      media: r.kind === 'photo' ? { url: `/api/chat/f/${r.file}`, thumb: `/api/chat/f/${r.thumb}`, w: r.width, h: r.height, gif: r.mime === 'image/gif' }
        : r.kind === 'gif' ? { url: r.gif_url, mp4: r.gif_mp4 || null, w: r.width, h: r.height, title: r.text || '' } : null,
      reactions: reacts[r.id] || {},
    };
  const outMany = (rows) => { const re = reactionsOf(rows.map((r) => r.id)); return rows.map((r) => rowOut(r, re)); };
  const getRow = (id) => db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(+id);

  // The chats someone is in, with unread counts and the last message (for the list and badges)
  function listFor(userId) {
    const chats = ['trip', ...db.prepare('SELECT subgroup_id FROM subgroup_members WHERE user_id = ?').all(userId).map((r) => `g:${r.subgroup_id}`)]
      .filter((c) => canSee(userId, c));
    return chats.map((chat) => {
      const read = db.prepare('SELECT last_id FROM chat_reads WHERE user_id = ? AND chat = ?').get(userId, chat)?.last_id || 0;
      const last = db.prepare('SELECT * FROM chat_messages WHERE chat = ? ORDER BY id DESC LIMIT 1').get(chat);
      const unread = db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat = ? AND id > ? AND user_id != ? AND deleted_at IS NULL').get(chat, read, userId).n;
      return { id: chat, name: chatName(chat), members: members(chat), readId: read, unread, last: last ? outMany([last])[0] : null };
    });
  }
  const sendChatList = (userIds) => { for (const id of userIds) sendToUsers([id], { t: 'chats', chats: listFor(id) }); };

  // @Name mentions: longest names first, so "@Sam Tanaka" isn't read as "@Sam"
  function findMentions(text, chat, fromId) {
    const people = members(chat).filter((id) => id !== fromId).map((id) => ({ id, name: nameOf(id) })).sort((a, b) => b.name.length - a.name.length);
    const found = new Set();
    const lower = String(text || '').toLowerCase();
    if (/(^|\s)@(everyone|all)\b/.test(lower)) people.forEach((p) => found.add(p.id));
    for (const p of people) {
      const at = `@${p.name.toLowerCase()}`;
      let i = lower.indexOf(at);
      while (i >= 0) {
        const after = lower[i + at.length];
        if ((i === 0 || /\s|[(“"']/.test(lower[i - 1])) && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) { found.add(p.id); break; }
        i = lower.indexOf(at, i + 1);
      }
    }
    return [...found];
  }

  // ---- sending ----
  // m: { chat, clientId, kind: 'text'|'photo'|'gif', text, replyTo, file, thumb, width, height, bytes, mime, gifUrl, gifMp4 }
  function post(user, m) {
    const chat = String(m.chat || '');
    if (!canSee(user.id, chat)) fail('You’re not in that chat.');
    const clientId = m.clientId ? String(m.clientId).slice(0, 64) : null;
    if (clientId) { // sent twice (offline queue, flaky network): same message
      const dup = db.prepare('SELECT * FROM chat_messages WHERE user_id = ? AND client_id = ?').get(user.id, clientId);
      if (dup) return outMany([dup])[0];
    }
    const recent = db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE user_id = ? AND created_at > ?').get(user.id, now() - 60e3).n;
    if (recent >= CHAT_RATE) fail('That’s a lot of messages. Wait a moment and try again.');
    const text = String(m.text || '').replace(/\r\n?/g, '\n').trim().slice(0, CHAT_TEXT_MAX);
    const kind = ['text', 'photo', 'gif'].includes(m.kind) ? m.kind : 'text';
    if (kind === 'text' && !text) fail('Type a message first.');
    if (kind === 'gif' && !isKlipyMedia(m.gifUrl)) fail('That GIF can’t be used.');
    let replyTo = m.replyTo ? +m.replyTo : null;
    if (replyTo) { const r = getRow(replyTo); if (!r || r.chat !== chat) replyTo = null; }
    const mentions = findMentions(text, chat, user.id);
    const id = Number(db.prepare(`INSERT INTO chat_messages(chat, user_id, kind, text, reply_to, mentions, file, thumb, width, height, bytes, mime, gif_url, gif_mp4, client_id, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chat, user.id, kind, text || null, replyTo, mentions.length ? JSON.stringify(mentions) : null,
      m.file || null, m.thumb || null, m.width || null, m.height || null, m.bytes || 0, m.mime || null,
      kind === 'gif' ? String(m.gifUrl) : null, kind === 'gif' && isKlipyMedia(m.gifMp4) ? String(m.gifMp4) : null, clientId, now()).lastInsertRowid);
    // the sender has read their own message
    db.prepare('INSERT INTO chat_reads(user_id, chat, last_id) VALUES(?, ?, ?) ON CONFLICT(user_id, chat) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)').run(user.id, chat, id);
    const out = outMany([getRow(id)])[0];
    const who = members(chat);
    sendToUsers(who, { t: 'chat', m: out });
    tell(user, out, who);
    return out;
  }

  // Notifications: mentions and replies by default; every message only for people who chose that.
  // Nobody is told about a message in a chat they have open on screen.
  function tell(user, m, who) {
    const watching = viewersOf(m.chat);
    const repliedTo = m.replyTo ? getRow(m.replyTo)?.user_id : null;
    const name = chatName(m.chat);
    const where = m.chat === 'trip' ? 'the trip chat' : name;
    const p = preview(m);
    const direct = [], rest = [];
    for (const id of who) {
      if (id === user.id || watching.has(id)) continue;
      if (m.mentions?.includes(id) || id === repliedTo) direct.push(id); else rest.push(id);
    }
    if (direct.length) {
      notifier.notify(direct.map((id) => ({ userId: id, kinds: ['chatMentions', 'chatAll'],
        text: { chatMentions: id === repliedTo && !m.mentions?.includes(id) ? `${user.name} replied in ${where}: ${p}` : `${user.name} mentioned you in ${where}: ${p}`, chatAll: `${user.name} in ${where}: ${p}` } })),
      { actorId: user.id, ref: { type: 'chat', id: m.chat } });
    }
    if (rest.length) {
      notifier.notify(rest.map((id) => ({ userId: id, kinds: ['chatAll'], merge: 'count',
        text: (k) => (k > 1 ? `${k} new messages in ${where}` : `${user.name} in ${where}: ${p}`) })),
      { ref: { type: 'chat', id: m.chat } }); // no actor: messages from different people merge
    }
  }

  function history(userId, chat, { before, after, limit = 50 } = {}) {
    if (!canSee(userId, chat)) fail('You’re not in that chat.');
    const lim = Math.min(Math.max(+limit || 50, 1), 100);
    const rows = after
      ? db.prepare('SELECT * FROM chat_messages WHERE chat = ? AND id > ? ORDER BY id ASC LIMIT ?').all(chat, +after, lim)
      : db.prepare('SELECT * FROM chat_messages WHERE chat = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chat, +before || Number.MAX_SAFE_INTEGER, lim).reverse();
    // replies to messages outside this page still show what they answer
    const ids = new Set(rows.map((r) => r.id));
    const extra = [...new Set(rows.map((r) => r.reply_to).filter((x) => x && !ids.has(x)))].map(getRow).filter((r) => r && r.chat === chat);
    return { messages: outMany(rows), quoted: outMany(extra), more: rows.length === lim };
  }

  function remove(user, id) {
    const r = getRow(id);
    if (!r || r.deleted_at) fail('That message is already gone.');
    if (!canSee(user.id, r.chat)) fail('You’re not in that chat.');
    if (r.user_id !== user.id && !user.is_admin) fail('You can only delete your own messages.');
    db.prepare('UPDATE chat_messages SET deleted_at = ?, text = NULL, mentions = NULL, gif_url = NULL, gif_mp4 = NULL WHERE id = ?').run(now(), r.id);
    db.prepare('DELETE FROM chat_reactions WHERE message_id = ?').run(r.id);
    sendToUsers(members(r.chat), { t: 'chat.update', m: outMany([getRow(r.id)])[0] });
    return r; // the caller drops photo files
  }

  function react(user, id, emoji, on) {
    const r = getRow(id);
    if (!r || r.deleted_at) fail('That message is gone.');
    if (!canSee(user.id, r.chat)) fail('You’re not in that chat.');
    if (!isReaction(emoji)) fail('Pick one of the reaction emoji.');
    if (on) {
      const n = db.prepare('SELECT COUNT(DISTINCT emoji) n FROM chat_reactions WHERE message_id = ?').get(r.id).n;
      if (n >= 20 && !db.prepare('SELECT 1 FROM chat_reactions WHERE message_id = ? AND emoji = ?').get(r.id, emoji)) fail('That message has enough different reactions.');
      const added = db.prepare('INSERT OR IGNORE INTO chat_reactions(message_id, user_id, emoji, created_at) VALUES(?, ?, ?, ?)').run(r.id, user.id, emoji, now()).changes;
      if (added && r.user_id !== user.id && !viewersOf(r.chat).has(r.user_id)) {
        notifier.notify([{ userId: r.user_id, kinds: ['reactions'], merge: 'count', text: (k) => (k > 1 ? `${k} reactions to your messages in ${r.chat === 'trip' ? 'the trip chat' : chatName(r.chat)}` : `${user.name} reacted ${emoji} to “${preview(r).slice(0, 60)}”`) }],
          { ref: { type: 'chat', id: r.chat } });
      }
    } else db.prepare('DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(r.id, user.id, emoji);
    sendToUsers(members(r.chat), { t: 'chat.update', m: outMany([getRow(r.id)])[0] });
  }

  function markRead(userId, chat, id) {
    if (!canSee(userId, chat)) return;
    const max = db.prepare('SELECT MAX(id) m FROM chat_messages WHERE chat = ?').get(chat).m || 0;
    db.prepare('INSERT INTO chat_reads(user_id, chat, last_id) VALUES(?, ?, ?) ON CONFLICT(user_id, chat) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)').run(userId, chat, Math.min(+id || 0, max));
    sendToUsers([userId], { t: 'chats', chats: listFor(userId) }); // badges on their other devices
  }

  // Can this person see this stored file (a chat photo)?
  const canSeeFile = (userId, file) => db.prepare('SELECT chat FROM chat_messages WHERE (file = ? OR thumb = ?) AND deleted_at IS NULL').all(file, file).some((r) => canSee(userId, r.chat));
  const mediaBytes = () => db.prepare('SELECT COALESCE(SUM(bytes), 0) n FROM chat_messages WHERE deleted_at IS NULL').get().n;
  const stats = () => db.prepare('SELECT COUNT(*) n, SUM(kind = \'photo\') photos, SUM(kind = \'gif\') gifs, COUNT(DISTINCT chat) chats FROM chat_messages WHERE deleted_at IS NULL').get();

  return { members, canSee, chatName, listFor, sendChatList, post, history, remove, react, markRead, canSeeFile, mediaBytes, stats, findMentions };
}
