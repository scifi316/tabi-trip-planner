// Emoji reactions: a quick way to say hi. Send one from a friend's card (or wave to everyone from the
// Friends list); when one arrives it pops up on screen with quick replies, and floats up from the
// sender's spot on the map.
import { state, on, op, emit, userById } from './store.js';
import { esc, avatar, ago, toast, icon } from './ui.js';
import { markRead } from './notifications.js';
import { emojiHtml, isCustom, openEmojiPicker } from './emoji.js';

const DEFAULT = ['👋', '❤️', '😂', '🎉', '🙏', '👍', '😮', '🍻'];
export const reactionSet = () => (state.config?.reactions?.length ? state.config.reactions : DEFAULT);
const NAMES = { '👋': 'wave', '❤️': 'heart', '😂': 'laugh', '🎉': 'party', '🙏': 'thanks', '👍': 'thumbs up', '😮': 'wow', '🍻': 'cheers' };
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function sendReaction(to, emoji, { from } = {}) {
  const r = await op('react.send', { to, emoji });
  if (r?.ok === false) { toast(r.error || 'Couldn’t send that. Check your connection.'); return false; }
  const who = to === 'all' ? 'everyone' : userById(to)?.name || 'them';
  toast(`Sent ${emoji} to ${who}`, { ms: 1800 }); // :name: reads fine as text
  if (from) popButton(from);
  return true;
}
function popButton(b) {
  b.classList.remove('popped');
  void b.offsetWidth;
  b.classList.add('popped');
}

// ---------- on a friend's card ----------
const between = (id) => state.reactions.filter((r) => (r.from === id && r.to === state.me?.id) || (r.to === id && r.from === state.me?.id));
export function reactionRowHtml(u) {
  const recent = between(u.id).slice(0, 3);
  return `<section class="friend-section react-section">
      <h3><span aria-hidden="true">👋</span> Say hi</h3>
      <div class="react-row" role="group" aria-label="Send ${esc(u.name)} a reaction">
        ${reactionSet().map((e) => `<button class="react-btn" data-react="${esc(e)}" aria-label="Send ${esc(u.name)} a ${esc(NAMES[e] || e)}" data-tip="Send ${esc(u.name)} ${esc(e)}">${esc(e)}</button>`).join('')}
        ${recentCustom().map((e) => `<button class="react-btn" data-react="${esc(e)}" aria-label="Send ${esc(u.name)} ${esc(e)}" data-tip="Send ${esc(u.name)} ${esc(e)}">${emojiHtml(e)}</button>`).join('')}
        <button class="react-btn more" data-react-more aria-label="Custom emojis" data-tip="Custom emojis made by the group, or add your own">${icon('smile')}<span class="more-plus">+</span></button>
      </div>
      ${recent.length ? `<ul class="react-log">${recent.map((r) => `<li>${r.from === state.me?.id ? 'You sent' : `${esc(u.name)} sent you`} <span class="react-e">${emojiHtml(r.emoji)}</span> <time>${ago(r.ts)}</time></li>`).join('')}</ul>` : ''}
    </section>`;
}
// The custom emojis you've used lately get their own buttons in the row (up to 3).
function recentCustom() {
  const names = new Set((state.customEmojis || []).map((e) => `:${e.name}:`));
  const out = [];
  for (const r of state.reactions) if (r.from === state.me?.id && isCustom(r.emoji) && names.has(r.emoji) && !out.includes(r.emoji)) { out.push(r.emoji); if (out.length === 3) break; }
  return out;
}
export function bindReactionRow(root, u) {
  root.querySelector('[data-react-more]')?.addEventListener('click', () => openEmojiPicker({ title: `Send ${u.name} a custom emoji`, onPick: (e) => sendReaction(u.id, e) }));
  root.querySelectorAll('[data-react]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    await sendReaction(u.id, b.dataset.react, { from: b });
    setTimeout(() => { b.disabled = false; }, 600);
  });
}

// ---------- arriving ----------
// One card at a time; more from the same person while it's up just update it ("Sam sent you 👋 ×3").
let card = null;
function showIncoming(r, all) {
  const u = userById(r.from);
  if (!u) return;
  if (!reduced()) burst(r.emoji);
  emit('reaction-pop', { userId: u.id, emoji: r.emoji });
  if (card && card.from === u.id && card.el.isConnected) {
    card.n++;
    card.el.querySelector('[data-what]').innerHTML = `${esc(u.name)} sent ${all ? 'everyone' : 'you'} <span class="react-e">${emojiHtml(r.emoji)}</span>${card.n > 1 ? ` <span class="react-count">×${card.n}</span>` : ''}`;
    clearTimeout(card.timer);
    card.timer = setTimeout(closeCard, 7000);
    return;
  }
  closeCard();
  const el = document.createElement('div');
  el.className = 'react-card';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <button class="react-who" data-open aria-label="Open ${esc(u.name)}’s card">${avatar(u)}</button>
    <div class="react-main">
      <div class="react-what" data-what>${esc(u.name)} sent ${all ? 'everyone' : 'you'} <span class="react-e">${emojiHtml(r.emoji)}</span></div>
      <div class="react-replies" role="group" aria-label="Reply to ${esc(u.name)}">
        ${['👋', '❤️', '😂', '🍻'].filter((e) => reactionSet().includes(e)).map((e) => `<button class="react-btn small" data-reply="${esc(e)}" aria-label="Reply with ${esc(NAMES[e] || e)}">${esc(e)}</button>`).join('')}
      </div>
    </div>
    <button class="icon-btn small react-close" data-x aria-label="Close"><svg class="i small" aria-hidden="true"><use href="#i-x"/></svg></button>`;
  document.body.appendChild(el);
  card = { el, from: u.id, n: 1, timer: setTimeout(closeCard, 7000) };
  el.querySelector('[data-x]').onclick = closeCard;
  el.querySelector('[data-open]').onclick = async () => {
    closeCard();
    emit('go', 'map');
    (await import('./friends.js')).openFriend(u.id, { pinpoint: true });
  };
  el.querySelectorAll('[data-reply]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    if (await sendReaction(u.id, b.dataset.reply, { from: b })) setTimeout(closeCard, 500);
    else b.disabled = false;
  });
  el.addEventListener('pointerenter', () => clearTimeout(card?.timer));
  el.addEventListener('pointerleave', () => { if (card) { clearTimeout(card.timer); card.timer = setTimeout(closeCard, 4000); } });
}
function closeCard() {
  if (!card) return;
  const { el, timer } = card;
  card = null;
  clearTimeout(timer);
  el.classList.add('leaving');
  setTimeout(() => el.remove(), 220);
}

// A handful of the emoji float up from the bottom of the screen
function burst(emoji) {
  const layer = document.createElement('div');
  layer.className = 'react-burst';
  layer.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 9; i++) {
    const s = document.createElement('span');
    if (isCustom(emoji)) s.innerHTML = emojiHtml(emoji, 'burst'); else s.textContent = emoji;
    s.style.left = `${8 + Math.random() * 84}%`;
    s.style.setProperty('--d', `${(Math.random() * 0.5).toFixed(2)}s`);
    s.style.setProperty('--s', (0.8 + Math.random() * 0.9).toFixed(2));
    s.style.setProperty('--x', `${Math.round((Math.random() - 0.5) * 80)}px`);
    layer.appendChild(s);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2600);
}

on('reaction', ({ r, all }) => {
  if (r.to !== state.me?.id || r.from === state.me?.id) return;
  if (document.hidden) return; // they'll see the notification
  if (state.me?.notifyPrefs?.reactions === false) return; // switched off in Settings
  showIncoming(r, all);
});
// Seen on screen, so its notification doesn't also need reading
on('notifs', (d) => {
  if (d?.fresh?.kind === 'reactions' && !document.hidden) setTimeout(() => markRead([d.fresh.id]), 400);
});
