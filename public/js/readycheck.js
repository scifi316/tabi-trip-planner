// Ready for Japan (TA-36): what the card at the top of Settings says.
// It reads the server's check for this person (state.me.ready) plus what this phone knows about
// itself right now. No DOM or app state in here, so it can be tested on its own.

export const REQUIRED = ['installed', 'push', 'location', 'recovery'];

// The words a tick or a fix button sits next to. Location reuses the OwnTracks status words.
const TONE = { working: 'good', stale: 'unknown', failing: 'bad', off: 'none', none: 'none' };

/**
 * ready: the server's check (or null before the first one arrives)
 * deviceId: this phone's id
 * local: what this phone knows itself: { installed, android, inApp, platform: 'ios' | 'android' | 'other',
 *   androidApp (an Android build is on offer), push: { support, on, blocked }, maps: { state, at } }
 * when(ts): "5 minutes ago"
 * Returns { items, done, total, deviceReady, personReady, otherDevice }
 */
export function readyModel(ready, deviceId, local, { when = () => '', pushHelp = {} } = {}) {
  const mine = ready?.devices?.find((d) => d.id === deviceId) || null;
  // Until the server has this phone's report, go by what the phone says about itself
  const installedOk = mine ? mine.checks.installed.ok : !!local.installed;
  const pushState = mine ? mine.checks.push.state : local.push?.on ? 'on' : local.push?.blocked ? 'blocked' : 'off';
  const mapsState = mine ? mine.checks.maps.state : local.maps?.state || 'none';
  const mapsAt = (mine ? mine.checks.maps.at : null) || local.maps?.at || null;
  const person = ready?.person || {};
  const items = [];

  // 1. On the home screen, or the Android app
  const android = local.inApp || (mine && mine.android);
  items.push(installedOk
    ? { key: 'installed', title: android ? 'Tabi for Android' : 'On your home screen', ok: true, text: android ? 'You’re using the Tabi app.' : 'Tabi opens full screen from your home screen.' }
    : local.platform === 'android' && local.androidApp
      ? { key: 'installed', title: 'On your home screen', ok: false, text: 'Get the Tabi app. It opens full screen and shares your location in the background.', action: { id: 'android', label: 'Get the app' } }
      : { key: 'installed', title: 'On your home screen', ok: false,
        text: local.platform === 'ios' ? 'In Safari, tap Share, then Add to Home Screen. Then open Tabi from there.'
          : local.platform === 'android' ? 'In Chrome, tap ⋮, then Add to Home screen or Install app.'
            : 'Install Tabi from your browser’s menu (Install app, or Add to Home Screen).',
        action: { id: 'install', label: 'Show me' } });

  // 2. Lock-screen notifications on this phone
  const support = local.push?.support || 'ok';
  items.push(pushState === 'on'
    ? { key: 'push', title: 'Lock-screen notifications', ok: true, text: 'On for this phone.' }
    : pushState === 'failing'
      ? { key: 'push', title: 'Lock-screen notifications', ok: false, text: 'Turned on, but the last ones didn’t arrive.', action: { id: 'push-on', label: 'Turn on again' } }
      : pushState === 'blocked' || local.push?.blocked
        ? { key: 'push', title: 'Lock-screen notifications', ok: false, text: 'Blocked for Tabi in this phone’s settings. Allow notifications for Tabi there, then come back.' }
        : support !== 'ok'
          ? { key: 'push', title: 'Lock-screen notifications', ok: false, text: support === 'ios-install' ? 'Add Tabi to your home screen first, then turn these on there.' : pushHelp[support] || 'This browser can’t show notifications when Tabi is closed.' }
          : { key: 'push', title: 'Lock-screen notifications', ok: false, text: 'Hear about plan changes and messages when Tabi is closed.', action: { id: 'push-on', label: 'Turn on' } });

  // 3. Location sharing, heard from lately (from any of your phones)
  const loc = person.location || { ok: false, state: 'off', label: 'Not set up' };
  const setup = { id: 'share-setup', label: 'Set up' };
  items.push({
    key: 'location', title: 'Location sharing', ok: !!loc.ok, label: loc.label, tone: TONE[loc.state] || 'none',
    text: loc.state === 'working' ? `Last location ${when(loc.at)}.`
      : loc.state === 'off' ? 'Off. Friends can’t see where you are.'
        : loc.state === 'stale' ? `Last location ${when(loc.at)}. Set up sharing when Tabi is closed so it keeps going.`
          : loc.state === 'failing' ? 'OwnTracks or the Tabi app is using an old token, so its locations are turned away.'
            : 'Sharing is on, but Tabi hasn’t had a location yet.',
    action: loc.ok ? null : loc.state === 'off' ? { id: 'share-on', label: 'Turn on' } : loc.state === 'failing' ? { id: 'share-setup', label: 'Fix' } : setup,
  });

  // 4. Recovery code
  const rec = person.recovery?.state || 'none';
  items.push(rec === 'saved'
    ? { key: 'recovery', title: 'Recovery code saved', ok: true, text: 'If you forget your password, use it on the sign-in screen.' }
    : { key: 'recovery', title: 'Recovery code saved', ok: false,
      text: rec === 'pending' ? 'Your code is ready, but you haven’t confirmed saving it.' : rec === 'unconfirmed' ? 'Did you save it? Tell Tabi, or make a new one.' : 'Lets you reset a forgotten password yourself, without an admin.',
      action: { id: 'recovery', label: rec === 'pending' ? 'View code' : rec === 'unconfirmed' ? 'Check' : 'Set up' } });

  // 5. Profile photo: optional
  items.push(person.photo?.ok
    ? { key: 'photo', title: 'Profile photo', optional: 'Optional', ok: true, text: 'Friends can spot you on the map.' }
    : { key: 'photo', title: 'Profile photo', optional: 'Optional', ok: false, text: 'So friends can spot you on the map.', action: { id: 'photo', label: 'Add photo' } });

  // 6. Offline maps on this phone: suggested
  items.push(mapsState === 'fresh'
    ? { key: 'maps', title: 'Offline maps', optional: 'Suggested', ok: true, text: `Saved around all places${mapsAt ? ` ${when(mapsAt)}` : ''}.` }
    : { key: 'maps', title: 'Offline maps', optional: 'Suggested', ok: false,
      text: mapsState === 'stale' ? 'Places changed since you saved them. Save again on Wi-Fi.' : 'Save the maps around all places on Wi-Fi, for when there’s no signal.',
      action: { id: 'maps', label: mapsState === 'stale' ? 'Save again' : 'Save maps' } });

  const required = items.filter((i) => REQUIRED.includes(i.key));
  const done = required.filter((i) => i.ok).length;
  const deviceReady = done === required.length;
  const personReady = !!ready?.ready;
  return { items, done, total: required.length, deviceReady, personReady, otherDevice: personReady && !deviceReady };
}

// The card shows until the end of the trip's first day (trip time zone).
export const cardHidden = (trip, today) => !!(trip?.start && today > trip.start);

// What an admin sees for one person in the member list.
export function memberLine(entry) {
  if (!entry) return null;
  if (entry.ready) return { tone: 'good', text: 'Ready for Japan' };
  return { tone: 'warn', text: `Not ready: ${entry.missing.join(', ')}` };
}

// The once-after-sign-in sheet: due unless shown before, or "Remind me later" hasn't run out.
export function promptDue(saved, now = Date.now()) {
  if (!saved) return true;
  if (saved.until) return saved.until <= now;
  return !saved.shown;
}
