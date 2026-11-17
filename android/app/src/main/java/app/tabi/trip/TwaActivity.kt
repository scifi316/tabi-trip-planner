package app.tabi.trip

import android.net.Uri
import android.os.Bundle
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * Opens Tabi in Chrome as a full-screen app (a Trusted Web Activity), so it keeps Chrome's sign-in,
 * offline copy and notifications. Adds the private-link key when this phone has one, and tells the
 * page it's running inside the Android app.
 */
class TwaActivity : LauncherActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Sharing stopped (a restart without "Allow all the time"): opening Tabi starts it again
        val cfg = Config(this)
        if (cfg.enabled && cfg.connected && Perms.location(this) && !LocationService.running) {
            try { LocationService.start(this) } catch (e: Exception) { }
        }
    }

    override fun getLaunchingUrl(): Uri {
        val incoming = intent?.data
        val base = if (incoming != null && incoming.scheme == "https" && BuildConfig.DEFAULT_HOST.equals(incoming.host, ignoreCase = true)) incoming
        else Uri.parse("https://${BuildConfig.DEFAULT_HOST}/")
        val b = base.buildUpon()
        if (base.getQueryParameter("app") == null) b.appendQueryParameter("app", "android")
        if (base.getQueryParameter("appv") == null) b.appendQueryParameter("appv", BuildConfig.VERSION_CODE.toString())
        val gate = Config(this).gate
        if (!gate.isNullOrBlank() && base.getQueryParameter("gate") == null && base.getQueryParameter("key") == null) b.appendQueryParameter("gate", gate)
        return b.build()
    }
}
