// What's new: the list of changes per release (public/changelog.json), and when to tell people Tabi
// was updated. Plain functions with no page access, so they can be tested on their own.

// '1.8.5' -> [1, 8, 5]. Anything else (an unstamped dev page, a build hash) -> null.
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
}
// -1, 0 or 1, or null when either isn't a version.
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
// The page's build stamp is '<version>-<hash>' (server/app.js BUILD): the version this page runs.
export function versionOfBuild(build) {
  const v = String(build ?? '').split('-')[0];
  return parseVersion(v) ? v : null;
}

// Valid releases, newest first. Bad entries are dropped rather than breaking Settings.
export function sortReleases(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.releases) ? data.releases : [];
  return list
    .filter((r) => r && parseVersion(r.version) && Array.isArray(r.changes))
    .map((r) => ({ ...r, changes: r.changes.filter((c) => typeof c === 'string' && c.trim()) }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

// The releases someone hasn't seen: newer than `since`, up to and including `running`.
// With no `since` (first time this device keeps track), just the running release.
export function releasesSince(releases, since, running) {
  const list = sortReleases(releases);
  if (!parseVersion(running)) return [];
  if (!parseVersion(since)) return list.filter((r) => compareVersions(r.version, running) === 0);
  return list.filter((r) => compareVersions(r.version, since) > 0 && compareVersions(r.version, running) <= 0);
}

// Should this page say "Tabi updated"? Once per version per device:
// - running newer than the last version this device saw: yes;
// - same version: no;
// - older (a rollback): no, but remember it, so moving forward again is announced;
// - nothing remembered yet: only if the device was already using Tabi before (an update to the
//   first version that keeps track); a brand-new sign-in isn't an update.
// `remember` is the version to store as seen, or null to leave storage alone.
export function decideAnnouncement({ running, lastSeen, returning }) {
  if (!parseVersion(running)) return { announce: false, remember: null, since: null };
  const cmp = compareVersions(running, lastSeen);
  if (cmp === null) return { announce: !!returning, remember: running, since: null };
  if (cmp > 0) return { announce: true, remember: running, since: lastSeen };
  if (cmp < 0) return { announce: false, remember: running, since: null };
  return { announce: false, remember: null, since: null };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// '2026-11-20' -> 'Nov 20, 2026' (the date as written, whatever the phone's time zone).
export function formatReleaseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))) return '';
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// A release can carry a short tag, like "Pre 1.9" for an early part of a bigger update.
function releaseHtml(r, open) {
  const date = formatReleaseDate(r.date);
  return `<details class="release" data-v="${esc(r.version)}"${open ? ' open' : ''}><summary><span class="label">Tabi ${esc(r.version)}${r.tag ? ` <span class="release-tag">${esc(r.tag)}</span>` : ''}</span>${date ? `<span class="help">${esc(date)}</span>` : ''}</summary>
    <ul>${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></details>`;
}
// The changelog: the newest `expanded` releases open, older ones folded under "Earlier updates".
export function changelogHtml(releases, { expanded = 3 } = {}) {
  const list = sortReleases(releases);
  if (!list.length) return '<div class="row"><div class="help">No updates listed yet.</div></div>';
  const recent = list.slice(0, expanded).map((r) => releaseHtml(r, true)).join('');
  const older = list.slice(expanded);
  return recent + (older.length ? `<details class="release older" data-v="older"><summary><span class="label">Earlier updates</span><span class="help">${older.length}</span></summary>
    ${older.map((r) => releaseHtml(r, false)).join('')}</details>` : '');
}
