// Your own place on the map (TA-20): a bubble with your profile photo, or your initials and colour
// when you have none, inside a blue ring with a soft pulse so it never reads as a friend.
// Kept apart from map.js so it can be tested without a map.
import { esc, initials, avatar } from './ui.js';

export const ME_BLUE = '#1A73E8';

// What the marker shows. While it stays the same, the marker is left alone (GPS moves it many times
// a minute, and rebuilding it would reload the photo and restart the pulse).
export function meMarkerKey(me) {
  if (!me) return '';
  return JSON.stringify([me.name || '', me.color || '', me.avatar || '']);
}

export function meMarkerLabel(following) {
  return following ? 'You. Tap to stop following your location.' : 'You. Tap to follow your location as you move.';
}

// The bubble: initials underneath, the photo on top, so a photo that fails to load falls back to them.
export function meMarkerHtml(me) {
  const letters = me?.name ? initials(me.name) : ''; // before your profile has loaded: a plain blue bubble
  const bg = me?.color || ME_BLUE;
  const photo = me?.avatar ? `<img src="${esc(me.avatar)}" alt="" decoding="async" draggable="false" onerror="this.remove()">` : '';
  return `<span class="me-pulse" aria-hidden="true"></span><span class="me-bubble" style="background:${esc(bg)}">${esc(letters)}${photo}</span>`;
}

// The same picture, small, for the "Following you" chip.
export function meChipAvatar(me) {
  return avatar(me, 'me-ring');
}
