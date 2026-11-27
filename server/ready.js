// Ready for Japan (TA-36): is each person's phone set up before the trip?
//
// Some checks belong to a device (each phone reports its own when it connects):
//   installed  Tabi opened from the home screen, or the Tabi for Android app
//   push       a lock-screen notification subscription on that device that isn't failing
//   maps       "Save maps around all places" has run there since the places last changed (suggested)
// The rest belong to the person:
//   location   sharing on, and a location heard lately (OwnTracks, the Android app or the open app)
//   recovery   a recovery code made and confirmed as saved
//   photo      a profile photo (optional)
// A person is ready when location and recovery pass and at least one of their devices passes
// installed and push. Profile photo and offline maps never block it.

export const LOCATION_FRESH_MS = 24 * 3600e3;
export const DEVICE_CHECKS = ['installed', 'push'];
export const MAPS_STATES = new Set(['fresh', 'stale', 'none']);

const DAY = 864e5;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
// "2 days", "30 hours": how long since a location arrived (only used past the 24-hour mark)
export function sinceWords(ms) {
  if (ms >= 2 * DAY) return plural(Math.floor(ms / DAY), 'day');
  return plural(Math.max(1, Math.floor(ms / 3600e3)), 'hour');
}

export function locationCheck(user, loc, now) {
  if (!user.share_location) return { ok: false, state: 'off', label: 'Not set up', missing: 'location sharing off' };
  // OwnTracks (or the Android app) was turned away with an old token after the last good location
  if (user.ot_status === 'bad-token' && (user.ot_status_at || 0) > (loc?.ts || 0)) {
    return { ok: false, state: 'failing', label: 'Failing', missing: 'location failing' };
  }
  if (!loc) return { ok: false, state: 'none', label: 'Not set up', missing: 'no location yet' };
  const age = Math.max(0, now - loc.ts);
  if (age > LOCATION_FRESH_MS) return { ok: false, state: 'stale', label: 'Not heard lately', at: loc.ts, missing: `location not heard for ${sinceWords(age)}` };
  return { ok: true, state: 'working', label: 'Working', at: loc.ts, source: loc.source || null };
}

export function recoveryCheck(status) {
  if (status === 'saved') return { ok: true, state: 'saved' };
  return status === 'none'
    ? { ok: false, state: 'none', missing: 'no recovery code' }
    : { ok: false, state: status, missing: 'recovery code not saved' };
}

export function deviceChecks(d, subs) {
  const sub = d.endpoint ? subs.find((s) => s.endpoint === d.endpoint) : null;
  const installed = d.installed
    ? { ok: true, state: d.android ? 'android' : 'home-screen' }
    : { ok: false, state: 'browser', missing: 'not on the home screen' };
  const push = sub && !sub.fails ? { ok: true, state: 'on', lastOk: sub.last_ok_at || null }
    : sub ? { ok: false, state: 'failing', missing: 'lock-screen notifications failing' }
      : d.blocked ? { ok: false, state: 'blocked', missing: 'notifications blocked on the phone' }
        : { ok: false, state: 'off', missing: 'no lock-screen notifications' };
  const maps = d.maps === 'fresh' ? { ok: true, state: 'fresh', at: d.maps_at || null }
    : d.maps === 'stale' ? { ok: false, state: 'stale', at: d.maps_at || null, missing: 'offline maps out of date' }
      : { ok: false, state: 'none', missing: 'offline maps not saved' };
  return { installed, push, maps };
}

/**
 * One person's readiness.
 * user: users row; devices: their device reports (newest first); subs: their push_subs rows;
 * loc: their locations row or null; recovery: 'none' | 'pending' | 'unconfirmed' | 'saved'.
 */
export function readiness({ user, devices = [], subs = [], loc = null, recovery = 'none', now = Date.now() }) {
  const location = locationCheck(user, loc, now);
  const rec = recoveryCheck(recovery);
  const photo = user.avatar ? { ok: true, state: 'set' } : { ok: false, state: 'none', missing: 'no profile photo' };
  const devs = devices.map((d) => {
    const checks = deviceChecks(d, subs);
    return { id: d.device_id, at: d.updated_at, android: !!d.android, ua: d.ua || '', checks, ok: DEVICE_CHECKS.every((k) => checks[k].ok) };
  });
  // The device closest to ready speaks for the person: most checks passing, then the most recent.
  const score = (d) => DEVICE_CHECKS.filter((k) => d.checks[k].ok).length;
  const best = [...devs].sort((a, b) => score(b) - score(a) || (b.at || 0) - (a.at || 0))[0] || null;
  const missing = [
    ...(best ? DEVICE_CHECKS.filter((k) => !best.checks[k].ok).map((k) => best.checks[k].missing) : ['no phone checked in yet']),
    ...(location.ok ? [] : [location.missing]),
    ...(rec.ok ? [] : [rec.missing]),
  ];
  const suggested = [...(photo.ok ? [] : [photo.missing]), ...(best && !best.checks.maps.ok ? [best.checks.maps.missing] : [])];
  return { id: user.id, ready: missing.length === 0, missing, suggested, best: best?.id || null, person: { location, recovery: rec, photo }, devices: devs };
}

// What admins see in the member list: just the verdict and the words.
export const summary = (r) => ({ id: r.id, ready: r.ready, missing: r.missing, suggested: r.suggested });

// A device's report, cleaned. Returns null when it isn't one.
export function cleanReport(m) {
  const id = String(m?.id || '');
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return null;
  const endpoint = typeof m.endpoint === 'string' && /^https:\/\//.test(m.endpoint) ? m.endpoint.slice(0, 1000) : null;
  return {
    id, installed: !!m.installed, android: !!m.android, endpoint, blocked: !endpoint && !!m.blocked,
    maps: MAPS_STATES.has(m.maps) ? m.maps : 'none', mapsAt: Number.isFinite(+m.mapsAt) && +m.mapsAt > 0 ? Math.round(+m.mapsAt) : null,
  };
}
