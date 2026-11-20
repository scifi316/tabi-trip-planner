// "Tabi updated" toast with a What's new link, the Changelog in Settings, and the "new version
// ready" toast while an update waits for the app to be free (see "staying up to date" in main.js).
import { toast, openSheet } from './ui.js';
import { sortReleases, releasesSince, decideAnnouncement, versionOfBuild, changelogHtml } from './changelog.js';

const SEEN = 'tabi.seenVersion';
// Was this device already using Tabi before this page loaded? (Read before anything saves state.)
const RETURNING = (() => { try { return !!localStorage.getItem('tabi.state'); } catch { return false; } })();

let cached = null;
// The changelog ships with the app (and is in the offline copy), so this works without a connection.
export function loadChangelog() {
  cached ||= fetch('/changelog.json', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null)).then(sortReleases)
    .catch(() => { cached = null; return []; });
  return cached;
}

export function openWhatsNew(releases, { title = 'What’s new' } = {}) {
  return openSheet({
    title, sub: releases.length === 1 ? `Tabi ${releases[0].version}` : '', className: 'whatsnew',
    body: `<div class="card changelog">${changelogHtml(releases, { expanded: releases.length })}</div>
      <p class="help whatsnew-more">Earlier updates are in Settings, under Changelog.</p>`,
  });
}

// Once per version per device: say Tabi was updated, with What's new when the changelog has it.
// Returns true when it said something.
export async function announceUpdate(pageBuild) {
  const running = versionOfBuild(pageBuild);
  let lastSeen = null;
  try { lastSeen = localStorage.getItem(SEEN); } catch { /* storage blocked: say nothing */ return false; }
  const d = decideAnnouncement({ running, lastSeen, returning: RETURNING });
  if (d.remember) { try { localStorage.setItem(SEEN, d.remember); } catch { /* ignore */ } }
  if (!d.announce) return false;
  const news = releasesSince(await loadChangelog(), d.since, running);
  toast(`Tabi updated to ${running}`, news.length ? { action: 'What’s new', onAction: () => openWhatsNew(news), ms: 9000 } : { ms: 5000 });
  return true;
}

// A newer version is waiting but the app is busy (a sheet open, typing): offer it now, once.
let readyShown = '';
export function offerUpdate(target, reload) {
  if (readyShown === target) return;
  readyShown = target;
  const v = versionOfBuild(target);
  toast(v ? `Tabi ${v} is ready` : 'A new version of Tabi is ready', { action: 'Reload', onAction: reload, ms: 12000 });
}

// Settings: fill the Changelog card (last 3 releases open, older ones folded). Settings redraws
// often, so the card fills at once when the changelog is already loaded, and what someone opened
// or closed stays that way.
const toggled = new Map(); // data-v -> open
export async function fillChangelog(card) {
  const releases = await loadChangelog();
  if (!card.isConnected) return;
  card.innerHTML = changelogHtml(releases, { expanded: 3 });
  card.querySelectorAll('details[data-v]').forEach((d) => {
    if (toggled.has(d.dataset.v)) d.open = toggled.get(d.dataset.v);
    d.addEventListener('toggle', () => toggled.set(d.dataset.v, d.open));
  });
}
