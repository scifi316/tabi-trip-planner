// What Tabi last heard from OwnTracks for you, in plain words: working, not heard lately, failing, or not set up.
import { esc, ago } from './ui.js';

const HOUR = 3600e3;
// "just now", "3 minutes ago", "2 hours ago": these read as sentences, unlike the compact list format
export function when(ts, now = Date.now()) {
  const a = ago(ts);
  if (a === 'now') return 'just now';
  const m = /^(\d+)([mhd]) ago$/.exec(a);
  if (!m) return a;
  const unit = { m: 'minute', h: 'hour', d: 'day' }[m[2]];
  return `${m[1]} ${unit}${m[1] === '1' ? '' : 's'} ago`;
}

export function ownTracksState(st, { sharing = true, now = Date.now(), inApp = false } = {}) {
  if (!st || !st.at) {
    return { tone: 'none', label: 'Not set up', text: inApp ? 'Nothing shared in the background yet.' : 'Tabi has never heard from OwnTracks on your account.' };
  }
  const info = st.info || {};
  // The Tabi Android app sends through the same address as OwnTracks
  const app = /^TabiAndroid/.test(info.ua || '');
  const via = app ? 'The Tabi app' : 'OwnTracks';
  const extra = [info.batt != null ? `${info.batt}% battery` : null, info.acc != null ? `accurate to ${Math.round(info.acc)} m` : null].filter(Boolean).join(', ');
  if (st.result === 'bad-token') {
    return { tone: 'bad', label: 'Failing', text: app ? `The Tabi app reached Tabi ${when(st.at)} with an old token. Tap “Set up background sharing” again.` : `OwnTracks reached Tabi ${when(st.at)} with the wrong password (token). Copy the token below into OwnTracks again.` };
  }
  if (st.result === 'ignored-sharing-off' || (!sharing && st.okAt)) {
    return { tone: 'warn', label: 'Not saved', text: `${via} reached Tabi ${when(st.at)}, but “Share my location with the group” is off, so the location wasn’t saved.` };
  }
  if (!st.okAt) {
    return { tone: 'warn', label: 'No location yet', text: app ? `The Tabi app reached Tabi ${when(st.at)}, but hasn’t sent a location yet.` : `OwnTracks reached Tabi ${when(st.at)}, but hasn’t sent a location yet. In OwnTracks, tap the upload button to send one now.` };
  }
  if (now - st.okAt > 6 * HOUR) {
    return { tone: 'unknown', label: 'Not heard lately', text: app ? `Last location ${when(st.okAt)}. Sharing may be stopped, or the phone may be offline. Open the Tabi app’s Location sharing screen to check.` : `Last location ${when(st.okAt)}. OwnTracks may be paused, or the phone may be offline. Open OwnTracks and tap the upload button to check.` };
  }
  return { tone: 'good', label: 'Working', text: `Last location ${when(st.okAt)}${app ? ' from the Tabi app' : ''}${extra ? `, ${extra}` : ''}.` };
}

export function ownTracksBadge(st, opts) {
  const s = ownTracksState(st, opts);
  return `<div class="ot-status" data-tone="${s.tone}" role="status"><span class="ot-pill"><span class="ot-dot"></span>${esc(s.label)}</span><span class="ot-text">${esc(s.text)}</span></div>`;
}
