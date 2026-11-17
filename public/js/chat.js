// Group chat: "Everyone" for the whole trip, plus a chat for each subgroup that only its members see.
// Text, photos, GIFs (KLIPY search, or a GIF from your phone), replies, @mentions and emoji reactions.
// Messages typed offline wait in the outbox and go when you reconnect.
import { state, on, op, emit, wsSend, chatBox, chatMerge, userById, groupById } from './store.js';
import { $, esc, icon, avatar, toast, openSheet, confirmSheet, uid, debounce } from './ui.js';
import { emojiHtml, withEmojis, openEmojiPicker, isCustom } from './emoji.js';
import { reactionSet } from './reactions.js';
import { meButton, currentTab } from './main.js';
import { wideScreen, markRead as markNotifsRead } from './notifications.js';
import { decodeImage, shrinkImage } from './photos.js';

const PAGE = 40;
const GROUP_GAP = 5 * 60e3;   // messages closer than this from the same person share one name/avatar
const GIF_MAX = 5 * 1048576;  // GIFs from your phone, kept as they are
const root = () => $('#screen-chat');
const meId = () => state.me?.id;
const nameOf = (id) => (id === meId() ? 'You' : userById(id)?.name || 'Someone');
const chatInfo = (id) => state.chats.find((c) => c.id === id);
const chatName = (id) => chatInfo(id)?.name || (id === 'trip' ? 'Everyone' : 'Subgroup');
const colorOf = (id) => (id === 'trip' ? 'var(--accent)' : groupById(id.slice(2))?.color || 'var(--ink-3)');
const coarse = () => matchMedia('(pointer: coarse)').matches;

let openId = null;       // the conversation on screen
let want = null;         // asked to open (from a notification) before the screen was ready
let dividerAt = 0;       // "New messages" goes above the first unread message when you opened the chat
let replyTo = null;      // message being replied to
let pushedHistory = false;
const drafts = new Map();
let loadingOlder = false;

// ---------- what a message looks like ----------
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function dayLabel(ts) {
  const d = new Date(ts), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (dayKey(ts) === dayKey(t)) return 'Today';
  if (dayKey(ts) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
}
function shortWhen(ts) {
  if (!ts) return '';
  if (dayKey(ts) === dayKey(Date.now())) return time(ts);
  if (Date.now() - ts < 6 * 864e5) return new Date(ts).toLocaleDateString([], { weekday: 'short' });
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
export function preview(m) {
  if (!m) return '';
  if (m.kind === 'deleted') return 'Message deleted';
  if (m.kind === 'photo') return `📷 ${m.text || (m.media?.gif ? 'GIF' : 'Photo')}`;
  if (m.kind === 'gif') return 'GIF';
  return String(m.text || '').replace(/\s+/g, ' ');
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const URL_RE = /\bhttps?:\/\/[^\s<>"]+[^\s<>"'.,:;!?)\]}]/g;
// Escaped text with custom emojis, @mentions (the ones the server matched) and links
function richText(m) {
  const names = [...new Set((m.mentions || []).map((id) => userById(id)?.name).filter(Boolean))].sort((a, b) => b.length - a.length);
  const mention = (html) => {
    let out = html;
    for (const n of [...names.map(esc), 'everyone', 'all']) {
      const isMe = n === esc(state.me?.name || '\u0000');
      out = out.replace(new RegExp(`(^|[\\s(“"'])(@${reEsc(n)})(?![\\p{L}\\p{N}_])`, 'giu'), (a, pre, at) => `${pre}<span class="mention${isMe || /^@(everyone|all)$/i.test(at) ? ' me' : ''}">${at}</span>`);
    }
    return out;
  };
  const text = String(m.text || '');
  let html = '', last = 0;
  for (const u of text.matchAll(URL_RE)) {
    html += mention(withEmojis(text.slice(last, u.index)));
    html += `<a href="${esc(u[0])}" target="_blank" rel="noopener noreferrer">${esc(u[0].replace(/^https?:\/\//, '').slice(0, 60))}${u[0].length > 68 ? '…' : ''}</a>`;
    last = u.index + u[0].length;
  }
  return html + mention(withEmojis(text.slice(last)));
}
// One to three emojis on their own are shown big
function bigEmoji(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return false;
  const rest = t.replace(/:[a-z0-9_]{2,24}:/g, '⭐');
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣\s]+$/u.test(rest)) return false;
  const n = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(rest.replace(/\s/g, ''))].length : rest.replace(/\s/g, '').length / 2;
  return n <= 3;
}
function quoteHtml(m) {
  if (!m.replyTo) return '';
  const q = chatBox(m.chat).list.find((x) => x.id === m.replyTo) || quoted.get(m.replyTo);
  return `<button class="msg-quote" data-jump="${m.replyTo}" style="--q:${q ? esc(userById(q.by)?.color || 'var(--ink-3)') : 'var(--ink-3)'}">
    <b>${q ? esc(nameOf(q.by)) : 'Earlier message'}</b><span>${q ? (q.kind === 'photo' && q.media ? `<img src="${esc(q.media.thumb)}" alt="">` : '') + withEmojis(preview(q).slice(0, 140)) : 'Not loaded'}</span></button>`;
}
const quoted = new Map(); // reply targets older than what's loaded

function mediaHtml(m) {
  const md = m.media;
  if (!md) return '';
  const w = md.w || 240, h = md.h || 180;
  const ar = `aspect-ratio:${w}/${h}`;
  if (m.kind === 'gif') {
    return `<button class="msg-media gif" data-gif style="${ar};--w:${Math.min(260, w)}px" aria-label="GIF${md.title ? `: ${esc(md.title)}` : ''}">
      <img src="${esc(md.url)}" alt="${esc(md.title || 'GIF')}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>`;
  }
  return `<button class="msg-media" data-photo style="${ar};--w:${Math.min(260, Math.round(260 * Math.min(1, w / h * 1.1)))}px" aria-label="Open photo">
    <img src="${esc(md.gif ? md.url : md.thumb)}" alt="${esc(m.text || 'Photo')}" loading="lazy" decoding="async">${md.gif ? '<span class="gif-tag">GIF</span>' : ''}</button>`;
}
function reactionsHtml(m) {
  const r = Object.entries(m.reactions || {}).filter(([, ids]) => ids.length);
  if (!r.length) return '';
  return `<div class="msg-rx">${r.map(([e, ids]) => {
    const mine = ids.includes(meId());
    const who = ids.map(nameOf).join(', ');
    return `<button class="rx${mine ? ' on' : ''}" data-rx="${esc(e)}" aria-pressed="${mine}" aria-label="${esc(who)} reacted ${esc(e)}" data-tip="${esc(who)}">${emojiHtml(e)}<span class="num">${ids.length > 1 ? ids.length : ''}</span></button>`;
  }).join('')}</div>`;
}

function msgHtml(m, { first, last }) {
  const mine = m.by === meId();
  const u = userById(m.by);
  const del = m.kind === 'deleted';
  const big = m.kind === 'text' && bigEmoji(m.text);
  const status = m.failed ? `<button class="msg-retry" data-retry>${icon('restore', 'small')}Not sent. Tap to try again</button>`
    : m.pending ? `<span class="msg-time" aria-label="Sending">${icon('clock', 'small')}</span>` : `<time class="msg-time" datetime="${new Date(m.at).toISOString()}">${time(m.at)}</time>`;
  const body = del ? `<div class="bubble deleted">${icon('trash', 'small')}${mine ? 'You deleted this message' : 'Message deleted'}</div>`
    : `<div class="bubble k-${m.kind}${big ? ' big' : ''}${m.media && !m.text ? ' bare' : ''}${(m.mentions || []).includes(meId()) ? ' at-me' : ''}">
        ${quoteHtml(m)}${mediaHtml(m)}${m.text && m.kind !== 'gif' ? `<div class="msg-text">${big ? withEmojis(m.text) : richText(m)}</div>` : ''}${status}</div>`;
  return `<div class="msg${mine ? ' mine' : ''}${first ? ' first' : ''}${last ? ' last' : ''}${m.pending ? ' pending' : ''}" data-id="${m.id || ''}" data-cid="${esc(m.clientId || '')}">
    ${!mine && first ? `<div class="msg-name" style="--c:${esc(u?.color || 'var(--ink-2)')}">${esc(nameOf(m.by))}</div>` : ''}
    <div class="msg-row">
      ${mine ? '' : last ? `<span class="msg-av">${avatar(u)}</span>` : '<span class="msg-av"></span>'}
      <div class="msg-col">${body}${del ? '' : reactionsHtml(m)}</div>
      ${del || m.pending ? '' : `<button class="msg-act" data-act aria-label="React, reply and more" data-tip="React or reply">${icon('smile', 'small')}</button>`}
    </div></div>`;
}

// The list as keyed pieces: day lines, the unread line, and messages
function pieces(list) {
  const out = [];
  let prev = null, divider = false;
  list.forEach((m, i) => {
    const next = list[i + 1];
    if (!prev || dayKey(prev.at) !== dayKey(m.at)) out.push({ key: `d:${dayKey(m.at)}`, html: `<div class="chat-day" role="separator"><span>${esc(dayLabel(m.at))}</span></div>` });
    if (!divider && dividerAt && m.id > dividerAt && m.by !== meId()) { divider = true; out.push({ key: 'new', html: '<div class="chat-new" role="separator" data-new><span>New messages</span></div>' }); }
    const join = (a, b) => a && b && a.by === b.by && dayKey(a.at) === dayKey(b.at) && Math.abs(b.at - a.at) < GROUP_GAP && a.kind !== 'deleted' && b.kind !== 'deleted'
      && !(dividerAt && a.id <= dividerAt && b.id > dividerAt);
    const first = !join(prev, m), last = !join(m, next);
    out.push({ key: m.id ? `m:${m.id}` : `p:${m.clientId}`, html: msgHtml(m, { first, last }) });
    prev = m;
  });
  return out;
}
// Only changed pieces are replaced, so pictures don't reload and the scroll position holds
function patch(container, items) {
  const have = new Map([...container.children].map((el) => [el.dataset.key, el]));
  let cursor = container.firstElementChild;
  for (const it of items) {
    let el = have.get(it.key);
    if (el && el._html !== it.html) { const fresh = make(it); el.replaceWith(fresh); have.set(it.key, fresh); if (cursor === el) cursor = fresh; el = fresh; }
    if (!el) { el = make(it); have.set(it.key, el); }
    if (el !== cursor) container.insertBefore(el, cursor); else cursor = cursor.nextElementSibling;
    have.delete(it.key);
  }
  for (const el of have.values()) el.remove();
}
function make({ key, html }) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  const el = t.content.firstElementChild;
  el.dataset.key = key; el._html = html;
  return el;
}

// ---------- the screen ----------
export function showChat() {
  const el = root();
  if (!el.firstElementChild) build();
  renderList();
  const target = want || openId || (wideScreen() ? 'trip' : null);
  want = null;
  if (target && chatInfo(target)) openChat(target, { fromShow: true });
  else if (!target) closeConvo({ quiet: true });
  syncView();
}
// Open a conversation (from the list, a notification or a link)
export function openChat(id, { fromShow = false } = {}) {
  if (currentTab() !== 'chat' || !root().firstElementChild) { want = id; return; }
  if (!chatInfo(id)) { if (state.chats.length) toast('That chat isn’t available to you anymore.'); return; }
  const changed = openId !== id;
  if (changed) {
    if (openId) drafts.set(openId, composer()?.value || '');
    openId = id;
    replyTo = null;
    dividerAt = chatInfo(id)?.unread ? chatInfo(id).readId || 0 : 0;
    if (!wideScreen() && !pushedHistory && !fromShow) { history.pushState({ chat: id }, '', '/#chat'); pushedHistory = true; }
  }
  $('#app').classList.toggle('chat-convo', !wideScreen());
  root().querySelector('.chat-wrap').dataset.open = '1';
  renderHead();
  renderComposer();
  renderMsgs({ scroll: changed ? 'open' : 'keep' });
  renderList();
  if (changed) load(id);
  syncView();
  if (changed && !coarse()) setTimeout(() => composer()?.focus({ preventScroll: true }), 60);
}
function closeConvo({ quiet = false } = {}) {
  if (openId) drafts.set(openId, composer()?.value || '');
  openId = null;
  $('#app').classList.remove('chat-convo');
  const w = root().querySelector('.chat-wrap');
  if (w) w.dataset.open = '0';
  if (!quiet) renderList();
  syncView();
}
// Phones show the list or a conversation; computers show both. Keep the tab bar right when the window changes size.
addEventListener('resize', debounce(() => { if (currentTab() === 'chat') $('#app').classList.toggle('chat-convo', !!openId && !wideScreen()); syncView(); }, 150));
addEventListener('popstate', () => {
  if (pushedHistory) { pushedHistory = false; if (openId && !wideScreen()) closeConvo(); }
});

function build() {
  root().innerHTML = `
    <div class="chat-wrap" data-open="0">
      <aside class="chat-side" aria-label="Chats">
        <header class="page-head" data-head></header>
        <div class="chat-list" role="list" data-list></div>
        <p class="chat-side-foot">${icon('users', 'small')}<span>Each subgroup gets its own chat, just for the people in it.</span></p>
      </aside>
      <section class="convo" aria-label="Conversation">
        <header class="convo-head" data-chead></header>
        <div class="convo-scroll" data-scroll tabindex="-1">
          <div class="convo-top" data-top></div>
          <div class="convo-msgs" data-msgs role="log" aria-live="polite" aria-relevant="additions"></div>
        </div>
        <button class="chat-jump" data-jump-latest hidden>${icon('arrow-down', 'small')}<span></span></button>
        <div class="composer" data-composer></div>
      </section>
      <div class="convo-empty">${icon('chat')}<p>Pick a chat</p></div>
    </div>`;
  const r = root();
  r.querySelector('[data-list]').addEventListener('click', (e) => { const b = e.target.closest('[data-chat]'); if (b) openChat(b.dataset.chat); });
  const sc = r.querySelector('[data-scroll]');
  sc.addEventListener('scroll', onScroll, { passive: true });
  // Turning the phone or opening the keyboard resizes the chat: stay at the latest message if you were there
  new ResizeObserver(() => { if (stick) sc.scrollTop = sc.scrollHeight; updateJump(); }).observe(sc);
  const msgs = r.querySelector('[data-msgs]');
  msgs.addEventListener('click', onMsgClick);
  msgs.addEventListener('contextmenu', (e) => { const m = e.target.closest('.msg'); if (!m || e.target.closest('a, input')) return; e.preventDefault(); openActions(m); });
  bindLongPress(msgs);
  r.querySelector('[data-jump-latest]').onclick = () => toBottom(true);
}

function renderList() {
  const r = root();
  if (!r?.firstElementChild) return;
  const total = state.chats.reduce((a, c) => a + (c.unread || 0), 0);
  r.querySelector('[data-head]').innerHTML = `${meButton()}<div class="grow"><h1>Chat</h1><div class="sub">${total ? `${total} unread` : state.conn === 'online' ? 'Everyone on the trip, and your subgroups' : 'Offline. Messages send when you reconnect'}</div></div>`;
  const list = [...state.chats].sort((a, b) => (a.id === 'trip' ? -1 : b.id === 'trip' ? 1 : (b.last?.at || 0) - (a.last?.at || 0)));
  r.querySelector('[data-list]').innerHTML = list.length ? list.map((c) => {
    const pend = chatBox(c.id).list.filter((x) => !x.id);
    const last = pend.at(-1) || c.last;
    return `<button class="chat-row${c.id === openId ? ' on' : ''}${c.unread ? ' unread' : ''}" role="listitem" data-chat="${esc(c.id)}" ${c.id === openId ? 'aria-current="true"' : ''}>
      ${roundel(c.id)}
      <span class="chat-row-main"><span class="chat-row-top"><b>${esc(c.name)}</b><time>${esc(shortWhen(last?.at))}</time></span>
        <span class="chat-row-last">${last ? `${last.by === meId() ? 'You' : esc(userById(last.by)?.name?.split(' ')[0] || 'Someone')}: ${withEmojis(preview(last).slice(0, 90))}`
          : `<i>${c.id === 'trip' ? 'Say hello to the group' : `${c.members.length} people. Nothing yet`}</i>`}</span></span>
      ${c.unread ? `<span class="chat-unread num" aria-label="${c.unread} unread">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</button>`;
  }).join('') : `<p class="chat-none">${state.conn === 'online' ? 'Loading chats…' : 'Chats appear once you’re connected.'}</p>`;
}
// Chats wear their line colour, like a station roundel: indigo for everyone, the subgroup's colour otherwise
function roundel(id, cls = '') {
  if (id === 'trip') return `<span class="roundel ${cls}" style="--c:var(--accent)">${icon('users', 'small')}</span>`;
  const g = groupById(id.slice(2));
  return `<span class="roundel ${cls}" style="--c:${esc(g?.color || 'var(--ink-3)')}">${esc((g?.name || '?').trim().slice(0, 1).toUpperCase())}</span>`;
}

function renderHead() {
  const c = chatInfo(openId);
  if (!c) return;
  const others = c.members.filter((id) => id !== meId()).map((id) => userById(id)).filter(Boolean);
  const online = new Set(state.online || []);
  const live = others.filter((u) => online.has(u.id)).length;
  const names = others.slice(0, 3).map((u) => u.name.split(' ')[0]).join(', ') + (others.length > 3 ? ` and ${others.length - 3} more` : '');
  root().querySelector('[data-chead]').innerHTML = `
    <button class="icon-btn convo-back" data-back aria-label="All chats">${icon('chevron-left')}</button>
    ${roundel(c.id, 'big')}
    <button class="convo-title" data-members aria-label="${esc(c.name)}: who’s in this chat"><b>${esc(c.name)}</b>
      <span class="sub">${others.length ? `You, ${esc(names)}` : 'Just you so far'}${live ? ` · <span class="live">${live} online</span>` : ''}</span></button>`;
  const h = root().querySelector('[data-chead]');
  h.querySelector('[data-back]').onclick = () => { if (pushedHistory) history.back(); else closeConvo(); };
  h.querySelector('[data-members]').onclick = () => membersSheet(c);
  h.style.setProperty('--chat-line', colorOf(c.id));
}
function membersSheet(c) {
  const online = new Set(state.online || []);
  const people = c.members.map((id) => userById(id)).filter(Boolean).sort((a, b) => (a.id === meId() ? -1 : b.id === meId() ? 1 : a.name.localeCompare(b.name)));
  openSheet({
    title: c.name, sub: c.id === 'trip' ? 'Everyone on the trip' : 'Only the people in this subgroup can see this chat',
    body: `<ul class="chat-people">${people.map((u) => `<li>${avatar(u)}<span class="grow">${esc(u.name)}${u.id === meId() ? ' (you)' : ''}</span>${online.has(u.id) ? '<span class="tag">Online</span>' : ''}</li>`).join('')}</ul>
      ${c.id !== 'trip' ? '<p class="help">People join and leave this chat as they’re added to or taken out of the subgroup.</p>' : ''}`,
  });
}

function renderMsgs({ scroll = 'keep' } = {}) {
  const r = root();
  if (!openId || !r?.firstElementChild) return;
  const sc = r.querySelector('[data-scroll]');
  const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
  const box = chatBox(openId);
  const c = chatInfo(openId);
  r.querySelector('[data-top]').innerHTML = box.more && box.list.length
    ? `<div class="convo-loading">${loadingOlder ? '<span class="spinner"></span>' : ''}</div>`
    : box.loaded || !box.more ? `<div class="convo-start">${roundel(openId, 'big')}<b>${esc(c?.name || '')}</b>
        <span>${openId === 'trip' ? 'The whole trip is here. Say hello, share photos, plan the night out.' : 'Just the people in this subgroup can read this chat.'}</span></div>` : '';
  patch(r.querySelector('[data-msgs]'), pieces(box.list));
  if (scroll === 'open') {
    requestAnimationFrame(() => {
      const nw = r.querySelector('[data-new]');
      if (nw) sc.scrollTop = Math.max(0, nw.offsetTop - 60); else sc.scrollTop = sc.scrollHeight;
      markReadSoon();
    });
  } else if (scroll === 'bottom' || (scroll === 'keep' && nearBottom)) {
    sc.scrollTop = sc.scrollHeight;
    markReadSoon();
  }
  updateJump();
}

async function load(id) {
  const box = chatBox(id);
  const r = await op('chat.history', { chat: id, limit: PAGE });
  if (r.ok === false) { if (!box.list.length && state.conn === 'online') toast(r.error || 'Couldn’t load the chat.'); return; }
  for (const q of r.quoted || []) quoted.set(q.id, q);
  chatMerge(id, r.messages || [], { more: r.more });
  if (openId === id) renderMsgs({ scroll: 'keep' });
}
async function loadOlder() {
  const box = chatBox(openId);
  const oldest = box.list.find((x) => x.id);
  if (loadingOlder || !box.more || !oldest) return;
  loadingOlder = true;
  const id = openId;
  const sc = root().querySelector('[data-scroll]');
  renderMsgs();
  const r = await op('chat.history', { chat: id, before: oldest.id, limit: PAGE });
  loadingOlder = false;
  if (r.ok === false || openId !== id) return renderMsgs();
  for (const q of r.quoted || []) quoted.set(q.id, q);
  const before = sc.scrollHeight - sc.scrollTop;
  chatMerge(id, r.messages || [], { more: r.more, older: true });
  renderMsgs();
  sc.scrollTop = sc.scrollHeight - before; // keep what you were reading in place
}

// ---------- reading ----------
let readTimer = 0;
function markReadSoon() {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (!viewing()) return;
    const sc = root().querySelector('[data-scroll]');
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 160) return;
    const c = chatInfo(openId);
    const last = [...chatBox(openId).list].reverse().find((x) => x.id);
    // Notifications about this chat are read once you've seen it
    const notes = state.notifications.filter((n) => !n.read && n.ref?.type === 'chat' && n.ref.id === openId).map((n) => n.id);
    if (notes.length) markNotifsRead(notes);
    if (!c || !last) return;
    if (c.unread || last.id > (c.readId || 0)) {
      c.unread = 0; c.readId = last.id;
      op('chat.read', { chat: openId, id: last.id });
      renderList();
      emit('chats');
    }
  }, 350);
}
const viewing = () => !!openId && currentTab() === 'chat' && !document.hidden && root()?.querySelector('.chat-wrap')?.dataset.open === '1';
// Tell the server which chat is on screen, so it doesn't notify you about messages you're watching arrive
let lastView;
function syncView() {
  const v = viewing() ? openId : null;
  state.chatViewing = v;
  if (v !== lastView) { lastView = v; wsSend({ t: 'chatview', chat: v }); }
  if (v) markReadSoon();
}
document.addEventListener('visibilitychange', syncView);
on('tab', (t) => { if (t !== 'chat') { $('#app').classList.remove('chat-convo'); if (pushedHistory) { pushedHistory = false; } } syncView(); });
on('state', () => { lastView = undefined; syncView(); if (openId && currentTab() === 'chat') load(openId); });

let stick = true;
function onScroll() {
  const sc = root().querySelector('[data-scroll]');
  stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
  if (sc.scrollTop < 300) loadOlder();
  updateJump();
  markReadSoon();
}
let unseen = 0;
function updateJump() {
  const sc = root().querySelector('[data-scroll]');
  const b = root().querySelector('[data-jump-latest]');
  const away = sc.scrollHeight - sc.scrollTop - sc.clientHeight > 240;
  if (!away) unseen = 0;
  b.hidden = !away;
  b.querySelector('span').textContent = unseen ? `${unseen} new` : 'Latest';
}
function toBottom(smooth) {
  const sc = root().querySelector('[data-scroll]');
  sc.scrollTo({ top: sc.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
}

on('chat', (d) => {
  if (!root()?.firstElementChild) return;
  if (d?.m && d.m.chat !== openId) return renderList();
  if (!openId) return renderList();
  const sc = root().querySelector('[data-scroll]');
  const near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
  const mineNew = d?.local || (d?.m && d.m.by === meId() && d.fresh); // what I just sent
  if (d?.fresh && !near && d.m.by !== meId()) unseen++;
  renderMsgs({ scroll: mineNew ? 'bottom' : 'keep' });
  renderList();
});
on('chats', () => {
  if (!root()?.firstElementChild) return;
  renderList();
  if (openId && !chatInfo(openId) && state.chats.length) { toast('You’re no longer in that chat.'); closeConvo(); if (wideScreen() && currentTab() === 'chat') openChat('trip'); }
  else if (openId) renderHead();
});
on('users', () => { if (openId && root()?.firstElementChild) { renderHead(); renderMsgs(); } });
on('subgroups', () => root()?.firstElementChild && renderList());
on('emojis', () => openId && renderMsgs());
on('conn', () => root()?.firstElementChild && renderList());

// ---------- tapping on messages ----------
function msgById(el) {
  const box = chatBox(openId);
  return el.dataset.id ? box.list.find((x) => x.id === +el.dataset.id) : box.list.find((x) => !x.id && x.clientId === el.dataset.cid);
}
function onMsgClick(e) {
  const el = e.target.closest('.msg');
  if (!el || Date.now() - pressedAt < 600) return;
  const m = msgById(el);
  if (!m) return;
  const rx = e.target.closest('[data-rx]');
  if (rx) return react(m, rx.dataset.rx, !(m.reactions?.[rx.dataset.rx] || []).includes(meId()));
  if (e.target.closest('[data-act]')) return openActions(el);
  if (e.target.closest('[data-photo]')) return openPhoto(m);
  if (e.target.closest('[data-retry]')) { delete m.failed; op('chat.send', { chat: m.chat, clientId: m.clientId, text: m.text, replyTo: m.replyTo, ...(m.kind === 'gif' ? { gif: { ...m.media, title: m.text } } : {}) }); return renderMsgs(); }
  const j = e.target.closest('[data-jump]');
  if (j) return jumpTo(+j.dataset.jump);
}
function jumpTo(id) {
  const el = root().querySelector(`.msg[data-id="${id}"]`);
  if (!el) return toast('That message is further back. Scroll up to load it.');
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
// Press and hold a message (phones) for reactions and replies
let pressedAt = 0;
function bindLongPress(box) {
  let t = 0, x0 = 0, y0 = 0;
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || e.target.closest('a, button.rx, [data-retry]')) return;
    const m = e.target.closest('.msg');
    if (!m) return;
    x0 = e.clientX; y0 = e.clientY;
    t = setTimeout(() => { pressedAt = Date.now(); navigator.vibrate?.(10); openActions(m); }, 450);
  });
  const cancel = (e) => { if (e.type !== 'pointermove' || Math.hypot(e.clientX - x0, e.clientY - y0) > 10) clearTimeout(t); };
  for (const ev of ['pointermove', 'pointerup', 'pointercancel']) box.addEventListener(ev, cancel, { passive: true });
}

function openActions(el) {
  const m = msgById(el);
  if (!m || !m.id || m.kind === 'deleted') return;
  if (Date.now() - openedActionsAt < 400) return;
  openedActionsAt = Date.now();
  const mine = m.by === meId();
  const recent = recentCustom();
  const s = openSheet({
    className: 'msg-actions',
    head: `<div class="grow"><h2>${esc(nameOf(m.by))}</h2><div class="sub">${esc(dayLabel(m.at))}, ${time(m.at)}</div></div>`,
    body: `<div class="act-quote">${m.kind === 'photo' && m.media ? `<img src="${esc(m.media.thumb)}" alt="">` : ''}<span>${withEmojis(preview(m).slice(0, 200))}</span></div>
      <div class="react-row" role="group" aria-label="React">
        ${[...reactionSet(), ...recent].map((e) => { const on = (m.reactions?.[e] || []).includes(meId()); return `<button class="react-btn${on ? ' on' : ''}" data-e="${esc(e)}" aria-pressed="${on}" aria-label="React ${esc(e)}">${emojiHtml(e)}</button>`; }).join('')}
        <button class="react-btn more" data-more aria-label="Custom emojis">${icon('smile')}<span class="more-plus">+</span></button></div>
      <div class="act-list">
        <button class="btn block" data-reply>${icon('reply')}Reply</button>
        ${m.text && m.kind === 'text' ? `<button class="btn block" data-copy>${icon('copy')}Copy text</button>` : ''}
        ${m.kind === 'photo' ? `<button class="btn block" data-open>${icon('external')}Open photo</button>` : ''}
        ${mine || state.me?.isAdmin ? `<button class="btn block danger" data-del>${icon('trash')}Delete${mine ? '' : ' (admin)'}</button>` : ''}
      </div>`,
  });
  s.el.querySelectorAll('[data-e]').forEach((b) => b.onclick = () => { s.close(); react(m, b.dataset.e, b.getAttribute('aria-pressed') !== 'true'); });
  s.el.querySelector('[data-more]').onclick = () => { s.close(); openEmojiPicker({ title: 'React with a custom emoji', onPick: (e) => react(m, e, true) }); };
  s.el.querySelector('[data-reply]').onclick = () => { s.close(); startReply(m); };
  s.el.querySelector('[data-copy]')?.addEventListener('click', async () => { s.close(); try { await navigator.clipboard.writeText(m.text); toast('Copied'); } catch { toast('Couldn’t copy. Select the text instead.'); } });
  s.el.querySelector('[data-open]')?.addEventListener('click', () => { s.close(); openPhoto(m); });
  s.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    s.close();
    if (!(await confirmSheet({ title: 'Delete this message?', body: 'It’s deleted for everyone in the chat.', confirm: 'Delete', danger: true }))) return;
    const r = await op('chat.delete', { id: m.id });
    if (r.ok === false) toast(r.error || 'Couldn’t delete it.');
  });
}
let openedActionsAt = 0;
function recentCustom() {
  const names = new Set((state.customEmojis || []).map((e) => `:${e.name}:`));
  const seen = [];
  for (const b of Object.values(state.chatMsgs)) for (const m of b.list) for (const [e, ids] of Object.entries(m.reactions || {})) if (isCustom(e) && names.has(e) && ids.includes(meId()) && !seen.includes(e)) seen.push(e);
  return seen.slice(-3);
}
async function react(m, emoji, onOff) {
  // show it straight away; the server's version replaces it
  const ids = new Set(m.reactions?.[emoji] || []);
  if (onOff) ids.add(meId()); else ids.delete(meId());
  m.reactions = { ...m.reactions, [emoji]: [...ids] };
  renderMsgs();
  const r = await op('chat.react', { id: m.id, emoji, on: onOff });
  if (r.ok === false) toast(r.error || 'Couldn’t react. Check your connection.');
}

// ---------- photos ----------
function openPhoto(m) {
  const md = m.media;
  if (!md) return;
  const el = document.createElement('div');
  el.className = 'photo-viewer chat-viewer';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', 'Photo');
  el.tabIndex = -1;
  const u = userById(m.by);
  el.innerHTML = `
    <div class="pv-top"><button class="icon-btn pv-close" data-close aria-label="Close">${icon('x')}</button><span class="grow"></span>
      <a class="icon-btn" href="${esc(md.url)}" download="tabi-chat-${m.id}.${md.url.split('.').pop()}" aria-label="Download" data-tip="Download">${icon('download')}</a></div>
    <div class="pv-stage"><img src="${esc(md.thumb || md.url)}" alt="" class="pv-low"><img src="${esc(md.url)}" alt="${esc(m.text || 'Photo')}" class="pv-img"></div>
    <div class="pv-foot"><div class="pv-who">${u ? avatar(u) : ''}<div class="grow"><b>${esc(nameOf(m.by))}</b> <span class="faint">${esc(dayLabel(m.at))}, ${time(m.at)}</span>
      ${m.text ? `<div class="pv-caption-text">${withEmojis(m.text)}</div>` : ''}</div></div></div>`;
  document.body.appendChild(el);
  const close = () => { el.remove(); removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', key);
  el.querySelector('[data-close]').onclick = close;
  el.focus();
}

// ---------- writing ----------
const composer = () => root()?.querySelector('[data-composer] textarea');
function renderComposer() {
  const box = root().querySelector('[data-composer]');
  const c = chatInfo(openId);
  box.innerHTML = `
    <div class="reply-bar" data-reply-bar hidden></div>
    <div class="mention-pop" data-mentions role="listbox" aria-label="People to mention" hidden></div>
    <div class="composer-row">
      <label class="icon-btn comp-btn" aria-label="Send a photo" data-tip="Send a photo">${icon('camera')}<input type="file" accept="image/*" data-file hidden></label>
      ${state.config.gifSearch ? '<button class="icon-btn comp-btn gif-btn" data-gif aria-label="Send a GIF" data-tip="Search KLIPY for a GIF">GIF</button>' : ''}
      <div class="comp-field">
        <textarea rows="1" maxlength="2000" placeholder="Message ${esc(c?.name || '')}" aria-label="Message ${esc(c?.name || '')}" enterkeyhint="${coarse() ? 'enter' : 'send'}"></textarea>
        <button class="icon-btn comp-emoji" data-emoji aria-label="Custom emojis" data-tip="Custom emojis">${icon('smile')}</button>
      </div>
      <button class="send-btn" data-send aria-label="Send" disabled>${icon('arrow-up')}</button>
    </div>`;
  const ta = composer();
  ta.value = drafts.get(openId) || '';
  const send = box.querySelector('[data-send]');
  const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; send.disabled = !ta.value.trim(); };
  fit();
  ta.addEventListener('input', () => { fit(); mentionSuggest(); });
  ta.addEventListener('keydown', (e) => {
    if (mentionKeys(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse()) { e.preventDefault(); sendText(); }
    if (e.key === 'Escape' && replyTo) { replyTo = null; renderReply(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { box.querySelector('[data-mentions]').hidden = true; }, 150));
  send.onclick = () => { sendText(); if (coarse()) ta.focus(); };
  box.querySelector('[data-file]').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendPhoto(f); };
  box.querySelector('[data-gif]')?.addEventListener('click', openGifs);
  box.querySelector('[data-emoji]').onclick = () => openEmojiPicker({ title: 'Custom emojis', onPick: (e) => insertAtCaret(`${e} `) });
  renderReply();
}
function insertAtCaret(text) {
  const ta = composer();
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + text.length;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}
function startReply(m) {
  replyTo = m;
  renderReply();
  composer()?.focus();
}
function renderReply() {
  const bar = root().querySelector('[data-reply-bar]');
  if (!bar) return;
  bar.hidden = !replyTo;
  if (!replyTo) return;
  bar.innerHTML = `${icon('reply', 'small')}<span class="grow">Replying to <b>${esc(nameOf(replyTo.by))}</b>: ${withEmojis(preview(replyTo).slice(0, 80))}</span>
    <button class="icon-btn small" data-cancel-reply aria-label="Cancel reply">${icon('x', 'small')}</button>`;
  bar.querySelector('[data-cancel-reply]').onclick = () => { replyTo = null; renderReply(); };
}
function sendText() {
  const ta = composer();
  const text = ta.value.trim();
  if (!text || !openId) return;
  if (text.length > 2000) return toast('That’s over 2,000 characters. Split it into two messages.');
  op('chat.send', { chat: openId, text, clientId: uid(), replyTo: replyTo?.id || null }).then((r) => { if (r?.queued) toast('You’re offline. It sends when you reconnect.', { ms: 2200 }); });
  ta.value = '';
  drafts.delete(openId);
  replyTo = null;
  renderReply();
  ta.dispatchEvent(new Event('input'));
}

// @mentions: type @ and pick a name
let mentionSel = 0, mentionList = [];
function mentionSuggest() {
  const ta = composer();
  const pop = root().querySelector('[data-mentions]');
  const before = ta.value.slice(0, ta.selectionStart);
  const m = /(?:^|\s)@([^\n@]{0,24})$/.exec(before);
  const c = chatInfo(openId);
  if (!m || !c) { pop.hidden = true; mentionList = []; return; }
  const q = m[1].toLowerCase();
  const people = c.members.filter((id) => id !== meId()).map(userById).filter(Boolean);
  mentionList = [...people.map((u) => ({ name: u.name, u })), ...(people.length > 1 ? [{ name: 'everyone' }] : [])]
    .filter((p) => p.name.toLowerCase().startsWith(q) || (q && p.name.toLowerCase().split(' ').some((w) => w.startsWith(q)))).slice(0, 6);
  if (!mentionList.length || (q.includes(' ') && !mentionList.some((p) => p.name.toLowerCase().startsWith(q)))) { pop.hidden = true; mentionList = []; return; }
  mentionSel = Math.min(mentionSel, mentionList.length - 1);
  pop.hidden = false;
  pop.innerHTML = mentionList.map((p, i) => `<button role="option" aria-selected="${i === mentionSel}" data-pick="${i}">${p.u ? avatar(p.u) : `<span class="roundel small" style="--c:var(--accent)">${icon('users', 'small')}</span>`}<span>${esc(p.name)}</span>${p.u ? '' : '<span class="faint">tell the whole chat</span>'}</button>`).join('');
  pop.querySelectorAll('[data-pick]').forEach((b) => b.onpointerdown = (e) => { e.preventDefault(); pickMention(+b.dataset.pick); });
}
function pickMention(i) {
  const p = mentionList[i];
  const ta = composer();
  if (!p) return;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos).replace(/@([^\n@]{0,24})$/, `@${p.name} `);
  ta.value = before + ta.value.slice(pos);
  ta.selectionStart = ta.selectionEnd = before.length;
  root().querySelector('[data-mentions]').hidden = true;
  mentionList = [];
  ta.dispatchEvent(new Event('input'));
  ta.focus();
}
function mentionKeys(e) {
  if (!mentionList.length || root().querySelector('[data-mentions]').hidden) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mentionSel = (mentionSel + (e.key === 'ArrowDown' ? 1 : -1) + mentionList.length) % mentionList.length; mentionSuggest(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionSel); return true; }
  if (e.key === 'Escape') { root().querySelector('[data-mentions]').hidden = true; mentionList = []; return true; }
  return false;
}

// A photo: shrunk in the browser like Picture a day; an animated GIF is sent as it is, with a still thumbnail.
function sendPhoto(file) {
  if (state.conn !== 'online') return toast('Photos send when you’re online. Try again once you’re connected.');
  const chat = openId;
  const reply = replyTo;
  const gif = file.type === 'image/gif' && file.size <= GIF_MAX;
  const s = openSheet({
    title: `Send to ${chatName(chat)}`, className: 'photo-add-sheet',
    body: `<div class="photo-preview" data-preview><div class="spinner"></div></div>
      <label class="field"><span>Caption (optional)</span><input class="input" data-caption maxlength="500" placeholder="Add a message"></label>
      <p class="help" data-info>Getting it ready…</p>
      <div class="progress" data-progress hidden><div></div></div>
      <p class="err" data-err hidden></p>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn primary" data-go disabled>Send</button>',
  });
  const q = (x) => s.el.querySelector(x);
  let ready = null, xhr = null;
  q('[data-cancel]').onclick = () => { xhr?.abort(); s.close(); };
  (async () => {
    const img = await decodeImage(file);
    const thumb = await shrinkImage(img, 640, 0.74);
    let full;
    if (gif) full = { blob: file, w: img.width || img.naturalWidth, h: img.height || img.naturalHeight };
    else { full = await shrinkImage(img, 2048, 0.82); if (full.blob.size > 2.5 * 1048576) full = await shrinkImage(img, 2048, 0.66); }
    img.close?.();
    return { thumb, full };
  })().then((p) => {
    ready = p;
    q('[data-preview]').innerHTML = `<img src="${URL.createObjectURL(p.full.blob)}" alt="">`;
    q('[data-info]').textContent = gif ? 'Animated GIF, sent as it is.' : file.type === 'image/gif' ? 'This GIF is over 5 MB, so it’s sent as a still photo.' : 'Location and camera details are removed.';
    q('[data-go]').disabled = false;
    if (!coarse()) q('[data-caption]').focus();
  }).catch(() => {
    q('[data-preview]').innerHTML = '';
    q('[data-info]').textContent = '';
    const err = q('[data-err]'); err.hidden = false;
    err.textContent = 'This browser can’t open that picture. On a computer, HEIC photos from an iPhone need converting first.';
  });
  q('[data-caption]').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !q('[data-go]').disabled) q('[data-go]').click(); });
  q('[data-go]').onclick = () => {
    if (!ready) return;
    q('[data-go]').disabled = true;
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, ready.thumb.blob.size);
    const meta = encodeURIComponent(JSON.stringify({ chat, clientId: uid(), text: q('[data-caption]').value.trim(), replyTo: reply?.id || null }));
    const bar = q('[data-progress]'); bar.hidden = false;
    xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/chat/photo');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Chat-Meta', meta);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = `${Math.round((e.loaded / e.total) * 100)}%`; };
    xhr.onload = () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status === 200) { s.close(); if (replyTo === reply) { replyTo = null; renderReply(); } return; }
      bar.hidden = true;
      const err = q('[data-err]'); err.hidden = false; err.textContent = j.error || `Couldn’t send it (${xhr.status}).`;
      q('[data-go]').disabled = false;
    };
    xhr.onerror = () => { bar.hidden = true; const err = q('[data-err]'); err.hidden = false; err.textContent = 'Couldn’t reach Tabi. Check your connection and try again.'; q('[data-go]').disabled = false; };
    xhr.send(new Blob([head, ready.thumb.blob, ready.full.blob]));
  };
}

// ---------- GIFs from KLIPY ----------
// Shown straight from KLIPY (its terms don't allow keeping copies), with its name on the search.
function openGifs() {
  const chat = openId;
  const reply = replyTo;
  const s = openSheet({
    title: 'GIFs', className: 'gif-sheet',
    body: `<div class="gif-search">${icon('search', 'small')}<input type="search" class="input" data-q placeholder="Search KLIPY" aria-label="Search KLIPY" enterkeyhint="search" autocomplete="off"></div>
      <div class="gif-grid" data-grid aria-live="polite"></div>
      <div class="gif-more" data-more></div>
      <p class="gif-credit">Powered by KLIPY</p>`,
  });
  const grid = s.el.querySelector('[data-grid]');
  const moreBox = s.el.querySelector('[data-more]');
  const input = s.el.querySelector('[data-q]');
  let q = '', page = 1, seq = 0, items = [];
  const fetchPage = async (reset) => {
    const my = ++seq;
    if (reset) { page = 1; items = []; grid.innerHTML = '<div class="spinner"></div>'; }
    moreBox.innerHTML = '';
    let j;
    try {
      const r = await fetch(`/api/gifs?q=${encodeURIComponent(q)}&page=${page}`, { credentials: 'same-origin' });
      j = await r.json();
      if (!r.ok) throw new Error(j.error || 'GIF search isn’t answering right now.');
    } catch (e) {
      if (my !== seq) return;
      grid.innerHTML = `<p class="gif-msg">${esc(e.message || 'GIF search isn’t answering right now.')}</p>`;
      return;
    }
    if (my !== seq) return;
    if (j.available === false) { grid.innerHTML = '<p class="gif-msg">GIF search isn’t set up on this server. You can still send a GIF from your phone with the camera button.</p>'; return; }
    items = [...items, ...(j.results || [])];
    grid.innerHTML = items.length ? items.map((g, i) => `<button class="gif-cell" data-i="${i}" style="aspect-ratio:${g.pw || 1}/${g.ph || 1}" aria-label="Send GIF${g.title ? `: ${esc(g.title)}` : ''}">
      <img src="${esc(g.preview)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></button>`).join('') : `<p class="gif-msg">No GIFs for “${esc(q)}”. Try another word.</p>`;
    if (j.more) { moreBox.innerHTML = '<button class="btn block small" data-next>More</button>'; moreBox.querySelector('[data-next]').onclick = () => { page++; fetchPage(false); }; }
  };
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    const g = items[+b.dataset.i];
    s.close();
    op('chat.send', { chat, clientId: uid(), replyTo: reply?.id || null, gif: { url: g.url, mp4: g.mp4, w: g.w, h: g.h, title: g.title } });
    if (replyTo === reply) { replyTo = null; renderReply(); }
  });
  input.addEventListener('input', debounce(() => { q = input.value.trim(); fetchPage(true); }, 350));
  fetchPage(true);
  if (!coarse()) setTimeout(() => input.focus(), 80);
}
