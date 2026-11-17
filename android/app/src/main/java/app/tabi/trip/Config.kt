package app.tabi.trip

import android.content.Context

/** What this phone knows: which account to share as (from the setup link) and how the last update went. */
class Config(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("tabi", Context.MODE_PRIVATE)

    val host: String get() = BuildConfig.DEFAULT_HOST
    var gate: String?
        get() = p.getString("gate", null)
        set(v) { p.edit().putString("gate", v).apply() }
    var user: String?
        get() = p.getString("user", null)
        set(v) { p.edit().putString("user", v).apply() }
    var token: String?
        get() = p.getString("token", null)
        set(v) { p.edit().putString("token", v).apply() }
    var enabled: Boolean
        get() = p.getBoolean("enabled", false)
        set(v) { p.edit().putBoolean("enabled", v).apply() }
    var lastOkAt: Long
        get() = p.getLong("lastOkAt", 0L)
        set(v) { p.edit().putLong("lastOkAt", v).apply() }
    /** ok, paused (sharing is off in Tabi), offline, error, bad-token, gone, no-permission */
    var lastResult: String?
        get() = p.getString("lastResult", null)
        set(v) { p.edit().putString("lastResult", v).apply() }
    var notifiedCode: Int
        get() = p.getInt("notifiedCode", 0)
        set(v) { p.edit().putInt("notifiedCode", v).apply() }

    val connected: Boolean get() = !user.isNullOrBlank() && !token.isNullOrBlank()

    fun disconnect() {
        p.edit().remove("user").remove("token").remove("lastResult").remove("lastOkAt").putBoolean("enabled", false).apply()
    }
}
