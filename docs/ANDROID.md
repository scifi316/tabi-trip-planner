# The Tabi Android app

An app for the Android phones in the group, so they don't need OwnTracks for background location. It's two things in one install:

- **Tabi itself**, opened full screen from the home screen. Underneath it's Chrome (a *Trusted Web Activity*), so the sign-in, offline copy and lock-screen notifications are the same ones the browser already has. Web updates arrive as usual, with no new APK.
- **Background location sharing**, a small native service. It shows a notification while it shares, with a Stop button, and posts to the same `/api/owntracks` address OwnTracks uses, so the server barely changes.

iPhones keep using the web app, plus OwnTracks for background sharing. Apple doesn't allow sideloading.

## For people on the trip

1. On an Android phone, open Tabi in the browser and go to **Settings › Location sharing**, then tap **Get the Android app**.
2. **Download**, then install. Android asks whether the browser may install apps: allow it for this one. It may also warn that the developer is unknown: tap *Install anyway*.
3. Back in the same sheet, tap **Connect the app**. The app opens and walks through:
   - location permission (needed)
   - notifications (to show that sharing is on)
   - not pausing Tabi to save battery
   - *Allow all the time*, so sharing restarts by itself after the phone restarts

   It starts sharing as soon as location is allowed, and switches "Share my location" on in Tabi if it was off.
4. From then on, open Tabi from the home screen icon.

To stop: use **Stop sharing** in the notification, or long-press the app icon and choose **Location sharing**. Turning "Share my location" off in Tabi pauses the app too. It then just checks in every 15 minutes to see whether it's back on.

### Battery

The service uses balanced accuracy: Wi-Fi and cell towers, plus GPS only when something else already has it on. It sends at most once a minute, and only after moving 15 m. When you're still, it checks in every 15 minutes. That's about what OwnTracks does in its "significant changes" mode.

## For the trip admin: building and publishing

### Builds

The **Android app** workflow on GitHub (`.github/workflows/android.yml`) builds the app whenever something under `android/` changes. You can also run it by hand from the Actions tab.

Each build replaces a pre-release called **android-build** on the repository's Releases page, with the APK attached. A comment on the commit says whether it worked; if it failed, the comment includes the compiler errors.

The app is built for `trip.sanechristmas.party`. To build it for another address, set a repository **variable** (not a secret) called `TABI_HOST`.

### Signing key (once)

Android only lets an installed app update to a new version signed with the **same key**. Until the key is set up, builds are signed with a throwaway key and called `Tabi-x.y.z-test.apk`. They're fine for trying the app out. But a phone that installed a test build has to uninstall it before it can install a properly signed one.

To set up the real key, on any computer with Java (for example the droplet: `apt install openjdk-17-jre-headless`):

```bash
keytool -genkeypair -keystore tabi.jks -alias tabi -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Tabi"
# choose a strong password when asked
base64 -w0 tabi.jks > tabi.jks.b64     # on macOS: base64 -i tabi.jks -o tabi.jks.b64
```

Then on GitHub, go to **Settings › Secrets and variables › Actions › New repository secret** and add:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_B64` | the contents of `tabi.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the password you chose |

Keep `tabi.jks` and its password somewhere safe, such as a password manager. If the key is lost, everyone has to uninstall and reinstall the app once. Delete `tabi.jks.b64` afterwards. Never commit either file; `.gitignore` already refuses `*.jks`.

After adding the secrets, run the workflow again (Actions › Android app › Run workflow). The new build is called `Tabi-1.0.0.apk`, without `-test`.

### Publishing a build to the group

1. Download the APK from the **android-build** release.
2. In Tabi, go to **Settings › Android app (admins)**, then **Upload a new version**.

Tabi reads the version and signing key from inside the APK. It warns you if:

- it's a test build
- it's older than the current one
- its version number didn't go up
- it's signed with a different key

As soon as it's uploaded, people on Android see the download in Settings. Phones that already have the app get an "update ready" notification within about 15 minutes.

**Releasing an update:** raise both `versionCode` and `versionName` in `android/version.properties`, push, then upload the new APK. Phones only treat it as an update when `versionCode` goes up.

### Full screen, without an address bar

Chrome shows Tabi full screen only when the site vouches for the app. Tabi does that automatically: once an APK is uploaded, the server publishes `/.well-known/assetlinks.json` with that APK's package name and signing fingerprint. That file is served without the private-link key, because Google checks it without cookies. It contains nothing about the trip.

If the app shows a thin address bar at the top, the check hasn't passed yet. Android re-checks within a day of installing, or when the app is reinstalled. You can also set `ANDROID_PACKAGE` and `ANDROID_CERT_SHA256` on the servers to publish a fingerprint without uploading an APK.

## Sideloading after 2026

Google is requiring every Android app to come from a verified developer, including ones installed outside the Play Store:

- From **30 September 2026** in Brazil, Indonesia, Singapore and Thailand.
- **Worldwide in 2027.**

Phones in other countries still install Tabi as described above for now.

Before it reaches your group's phones, register a free **limited-distribution** developer account in the Android Developer Console. It lets you install your own app on up to 20 devices, which is enough for a trip. Register the package name `app.tabi.trip` with the same signing key as above. No app store listing is needed.

## How it fits together

```
android/
  version.properties          versionName / versionCode (raise both for each release)
  app/src/main/java/app/tabi/trip/
    TwaActivity.kt            opens https://<host>/?app=android&appv=<code> full screen in Chrome
    SetupActivity.kt          the Location sharing screen; handles tabi://setup links
    LocationService.kt        foreground service: locations to /api/owntracks (OwnTracks JSON)
    BootReceiver.kt           carries on after a restart (needs "Allow all the time")
    Config.kt, Perms.kt       saved settings; which permissions are granted
```

- **Connecting:** Settings builds a link `tabi://setup?h=<host>&g=<private-link key>&u=<name>&t=<OwnTracks token>&start=1`. The app keeps these values in its private storage. "Make a new token" in Tabi disconnects the phone; the app then stops and says so.
- **Server replies:** on every location, the server answers with `X-Tabi-Sharing: on|off` (the app pauses when it's off) and, once an app has been uploaded, `X-Tabi-App-Latest: <versionCode>` (the app offers the update).
- **Status in Settings:** the "Share even when Tabi is closed" status says "from the Tabi app" when the app is the one sending.
