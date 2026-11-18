package app.tabi.trip

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Updates the app in place, from Tabi itself: no browser, no uninstalling.
 *
 * 1. check(): Tabi says which version an admin last uploaded, and its SHA-256.
 * 2. download(): fetched with the same name + token the app uses for locations, then checked
 *    against that SHA-256, so a half-finished or swapped download is never installed.
 * 3. install(): handed to Android's installer. Android shows "Do you want to update this app?",
 *    and refuses anything not signed with the same key as the installed app.
 *
 * The first time, Android asks to allow Tabi to install apps (a switch in Settings). After the
 * first update made this way, Android 12 and later can install later ones without asking.
 */
object Updater {
    const val ACTION_STATUS = "app.tabi.trip.INSTALL_STATUS"

    data class Latest(val version: String, val code: Int, val size: Long, val sha256: String, val test: Boolean)

    private fun open(cfg: Config, path: String): HttpURLConnection {
        val gate = cfg.gate
        val address = "https://${cfg.host}$path" + (if (gate.isNullOrBlank()) "" else "?gate=" + Uri.encode(gate))
        val c = URL(address).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 60_000
        c.setRequestProperty("Authorization", "Basic " + Base64.encodeToString("${cfg.user}:${cfg.token}".toByteArray(), Base64.NO_WRAP))
        c.setRequestProperty("User-Agent", "TabiAndroid/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE})")
        return c
    }

    /** The version Tabi offers, or null when there's none or it can't be reached. Call off the main thread. */
    fun check(ctx: Context): Latest? {
        val cfg = Config(ctx)
        if (!cfg.connected) return null
        return try {
            val c = open(cfg, "/api/app/latest")
            try {
                if (c.responseCode != 200) return null
                val j = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
                val code = j.optInt("code", 0)
                if (code <= 0) return null
                Latest(j.optString("version"), code, j.optLong("size"), j.optString("sha256"), j.optBoolean("test"))
            } finally {
                c.disconnect()
            }
        } catch (e: Exception) {
            null
        }
    }

    fun isNewer(l: Latest?) = l != null && l.code > BuildConfig.VERSION_CODE

    /** Downloads and checks the update. Call off the main thread. Throws with a message for people. */
    fun download(ctx: Context, latest: Latest, progress: (Int) -> Unit): File {
        val cfg = Config(ctx)
        val out = File(ctx.cacheDir, "tabi-update.apk")
        out.delete()
        val c = open(cfg, "/api/app/tabi.apk")
        try {
            if (c.responseCode != 200) throw Exception("Tabi answered ${c.responseCode} to the download. Try again later.")
            val total = c.contentLengthLong.takeIf { it > 0 } ?: latest.size
            val md = MessageDigest.getInstance("SHA-256")
            var done = 0L
            var shown = -1
            c.inputStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        md.update(buf, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt() else 0
                        if (pct != shown) { shown = pct; progress(pct) }
                    }
                }
            }
            val sum = md.digest().joinToString("") { "%02x".format(it) }
            if (latest.sha256.isNotBlank() && !sum.equals(latest.sha256, ignoreCase = true)) {
                out.delete()
                throw Exception("The download didn’t match what Tabi published. Try again.")
            }
            return out
        } finally {
            c.disconnect()
        }
    }

    /** Android 8+: Tabi needs "Install unknown apps" allowed before it can install its own updates. */
    fun canInstall(ctx: Context) = ctx.packageManager.canRequestPackageInstalls()

    fun installPermissionIntent(ctx: Context) =
        Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))

    /** Hands the file to Android's installer. The result arrives at the activity as ACTION_STATUS. */
    fun install(activity: Activity, apk: File) {
        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(activity.packageName)
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("tabi.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            // Android fills in the result, so this one has to be mutable
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val status = PendingIntent.getActivity(activity, 7,
                Intent(activity, SetupActivity::class.java).setAction(ACTION_STATUS), flags)
            session.commit(status.intentSender)
        }
    }
}
