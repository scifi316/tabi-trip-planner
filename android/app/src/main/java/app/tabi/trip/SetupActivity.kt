package app.tabi.trip

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.format.DateUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Background location sharing: connect (from the link in Tabi's Settings), allow what Android
 * needs, and start or stop. Everything is explained in plain words; nothing here is required to use Tabi.
 */
class SetupActivity : Activity() {
    private lateinit var cfg: Config
    private lateinit var box: LinearLayout
    private var chain = false          // walking through the permissions after "Start sharing"
    private val asked = mutableSetOf<String>()
    private var notice: String? = null
    private val ui = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            render()
            ui.postDelayed(this, 10_000L)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        cfg = Config(this)
        LocationService.channels(this)
        box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(32))
        }
        val scroll = ScrollView(this).apply {
            setBackgroundColor(getColor(R.color.bg))
            isFillViewport = true
            addView(box)
        }
        scroll.setOnApplyWindowInsetsListener { v, insets -> padForBars(v, insets); insets }
        setContentView(scroll)
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    override fun onResume() {
        super.onResume()
        render()
        ui.postDelayed(tick, 10_000L)
        if (chain) ui.post { next() }
    }

    override fun onPause() {
        ui.removeCallbacks(tick)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        render()
    }

    // tabi://setup?h=<host>&g=<private-link key>&u=<name>&t=<OwnTracks token>&start=1
    private fun handle(i: Intent?) {
        val d = i?.data
        if (d != null && d.scheme == "tabi" && d.host == "setup") {
            val h = d.getQueryParameter("h")
            val u = d.getQueryParameter("u")
            val t = d.getQueryParameter("t")
            if (!h.isNullOrBlank() && !h.equals(BuildConfig.DEFAULT_HOST, ignoreCase = true)) {
                notice = "That link is for $h, but this copy of the app is for ${BuildConfig.DEFAULT_HOST}."
            } else if (u.isNullOrBlank() || t.isNullOrBlank()) {
                notice = "That link is missing your details. Open Tabi’s Settings and tap “Set up background sharing” again."
            } else {
                val changed = u != cfg.user || t != cfg.token
                cfg.user = u
                cfg.token = t
                cfg.gate = d.getQueryParameter("g")?.takeIf { it.isNotBlank() }
                if (changed) cfg.lastResult = null
                notice = null
                if (cfg.enabled && Perms.location(this)) LocationService.start(this) // picks up a new token
                if (d.getQueryParameter("start") == "1" && !(cfg.enabled && LocationService.running)) {
                    chain = true
                    asked.clear()
                }
            }
            setIntent(Intent(this, SetupActivity::class.java)) // don't handle the link again after a rotation
        }
        render()
    }

    // One step at a time: location, notifications, then sharing starts; battery and "all the time" are extras
    private fun next() {
        if (!cfg.connected) { chain = false; return }
        if (!Perms.location(this)) {
            if ("loc" in asked) { chain = false; render(); return }
            asked += "loc"
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1)
            return
        }
        if (!Perms.notifications(this) && "notif" !in asked) {
            asked += "notif"
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
            return
        }
        if (!cfg.enabled || !LocationService.running) startSharing()
        if (!Perms.battery(this) && "batt" !in asked) { asked += "batt"; askBattery(); return }
        if (!Perms.background(this) && "bg" !in asked) { asked += "bg"; askBackground(); return }
        chain = false
        render()
    }

    private fun startSharing() {
        cfg.enabled = true
        try { LocationService.start(this) } catch (e: Exception) { notice = "Android didn’t let sharing start. Try again." }
        ui.postDelayed({ render() }, 600L)
    }

    private fun stopSharing() {
        cfg.enabled = false
        LocationService.stop(this)
        ui.postDelayed({ render() }, 300L)
    }

    private fun askLocation() {
        val blocked = "loc" in asked && !shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
        asked += "loc"
        if (blocked) openAppSettings() else requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1)
    }

    // Android 11+ sends people to a settings page for this one: "Allow all the time"
    private fun askBackground() {
        if (Build.VERSION.SDK_INT < 29) return
        if ("bg-asked" in asked) { openAppSettings(); return }
        asked += "bg-asked"
        requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), 3)
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        if ("notif" in asked) {
            try {
                startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            } catch (e: Exception) { openAppSettings() }
            return
        }
        asked += "notif"
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 2)
    }

    @SuppressLint("BatteryLife")
    private fun askBattery() {
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (e2: Exception) { }
        }
    }

    private fun openAppSettings() {
        try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))) } catch (e: Exception) { }
    }

    private fun openTabi(fragment: String = "") {
        startActivity(Intent(this, TwaActivity::class.java).setData(Uri.parse("https://${BuildConfig.DEFAULT_HOST}/$fragment")))
    }

    // ---------- the screen ----------
    private fun render() {
        box.removeAllViews()
        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(ImageView(this).apply { setImageResource(R.mipmap.ic_launcher) }, LinearLayout.LayoutParams(dp(48), dp(48)))
        head.addView(label("Location sharing", 22f, R.color.ink, true).apply { setPadding(dp(12), 0, 0, 0) })
        add(head)
        add(label("Shares where you are with the trip while Tabi is closed and your phone is in your pocket. Only people on the trip can see it, and you can stop any time.", 15f, R.color.ink2), 12)
        notice?.let { add(callout(it), 16) }

        if (!cfg.connected) {
            add(card("Connect your account", "Open Tabi, go to Settings, and under Location tap “Set up background sharing”. That links this app to your account."), 20)
            add(primary("Open Tabi") { openTabi("#settings") }, 16)
            footer()
            return
        }

        val on = cfg.enabled && LocationService.running
        add(status(on), 20)
        add(if (on) secondary("Stop sharing") { stopSharing() } else primary("Start sharing") { chain = true; asked.clear(); next() }, 12)
        if (on) add(secondary("Send my location now") { LocationService.ping(this); ui.postDelayed({ render() }, 3_000L) }, 8)
        lastTry()?.let { add(label(it, 12.5f, R.color.ink2), 10) }

        add(label("To keep it working", 14f, R.color.ink2, true), 28)
        val loc = Perms.location(this)
        add(row("Location", loc,
            if (loc && !Perms.precise(this)) "Allowed, but only roughly. Precise location helps friends find you."
            else "Needed to share where you are.", "Allow") { askLocation() }, 8)
        if (Build.VERSION.SDK_INT >= 33) {
            add(row("Notifications", Perms.notifications(this), "Shows that sharing is on, with a Stop button. Tabi’s own notifications use it too.", "Allow") { askNotifications() }, 8)
        }
        add(row("Battery", Perms.battery(this), "Stops Android from pausing Tabi to save power. Sharing uses very little.", "Allow") { askBattery() }, 8)
        if (Build.VERSION.SDK_INT >= 29) {
            add(row("Allow all the time", Perms.background(this), "Lets sharing start again by itself after your phone restarts. Choose “Allow all the time”.", "Choose") { askBackground() }, 8)
        }
        footer()
    }

    private fun status(on: Boolean): View {
        val (title, text, color) = when {
            !on && (cfg.lastResult == "bad-token" || cfg.lastResult == "gone") ->
                Triple("Not sharing", "Tabi no longer accepts this phone. Open Tabi’s Settings and tap “Set up background sharing” again.", R.color.red)
            !on -> Triple("Not sharing", "Tap Start sharing to share your location in the background.", R.color.ink2)
            cfg.lastResult == "paused" -> Triple("Paused", "“Share my location” is off in Tabi, so nothing is shared. Turn it on in Tabi and sharing picks up again.", R.color.amber)
            cfg.lastResult == "offline" -> Triple("Sharing as ${cfg.user}", "Can’t reach Tabi right now${lastText(", last shared ")}. It keeps trying.", R.color.amber)
            cfg.lastOkAt > 0 -> Triple("Sharing as ${cfg.user}", "Last shared ${ago(cfg.lastOkAt)}.", R.color.green)
            else -> Triple("Sharing as ${cfg.user}", "Finding you…", R.color.green)
        }
        val c = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            background = rounded(R.color.surface, 16)
            setPadding(dp(16), dp(14), dp(16), dp(14))
        }
        val dotColor = getColor(color)
        val dot = View(this).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(dotColor) } }
        c.addView(dot, LinearLayout.LayoutParams(dp(12), dp(12)).apply { topMargin = dp(6); rightMargin = dp(12) })
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(label(title, 17f, R.color.ink, true))
        col.addView(label(text, 14.5f, R.color.ink2).apply { setPadding(0, dp(2), 0, 0) })
        c.addView(col, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        return c
    }

    // For finding problems: when the app last tried, and what Tabi answered
    private fun lastTry(): String? {
        if (cfg.lastTryAt <= 0) return null
        val what = when (val code = cfg.lastCode) {
            0 -> "couldn’t reach Tabi" + (cfg.lastError?.let { " ($it)" } ?: "")
            200 -> "Tabi took it" + if (cfg.lastResult == "paused") ", but sharing is off in Tabi" else ""
            401 -> "Tabi didn’t accept the name and token (401)"
            404 -> "Tabi wasn’t found: the private link key may be wrong (404)"
            else -> "Tabi answered $code"
        }
        return "Last try ${ago(cfg.lastTryAt)}: $what."
    }

    private fun lastText(prefix: String) = if (cfg.lastOkAt > 0) prefix + ago(cfg.lastOkAt) else ""
    private fun ago(t: Long): String = DateUtils.getRelativeTimeSpanString(t, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString().replaceFirstChar { it.lowercase() }

    private fun footer() {
        add(secondary("Open Tabi") { openTabi() }, 28)
        if (cfg.connected) {
            add(label("Connected to ${BuildConfig.DEFAULT_HOST} as ${cfg.user}.", 13f, R.color.ink2), 18)
            add(Button(this).apply {
                text = "Disconnect this phone"
                isAllCaps = false
                setTextColor(getColor(R.color.red))
                background = null
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setPadding(0, 0, 0, 0)
                setOnClickListener { cfg.disconnect(); LocationService.stop(this@SetupActivity); ui.postDelayed({ render() }, 300L) }
            }, 0)
        }
        add(label("Tabi for Android ${BuildConfig.VERSION_NAME}", 12f, R.color.ink2), 12)
    }

    // ---------- small pieces ----------
    private fun dp(v: Int) = (v * resources.displayMetrics.density + 0.5f).toInt()

    private fun add(v: View, top: Int = 0) {
        box.addView(v, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) })
    }

    private fun label(s: String, size: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(getColor(color))
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setLineSpacing(0f, 1.15f)
    }

    private fun rounded(color: Int, radius: Int): GradientDrawable {
        val fill = getColor(color)
        val r = dp(radius).toFloat()
        return GradientDrawable().apply {
            setColor(fill)
            cornerRadius = r
        }
    }

    private fun button(s: String, fill: Int, ink: Int, onClick: () -> Unit) = Button(this).apply {
        text = s
        isAllCaps = false
        setTextColor(getColor(ink))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = Typeface.DEFAULT_BOLD
        background = rounded(fill, 14)
        stateListAnimator = null
        minHeight = dp(52)
        setOnClickListener { onClick() }
    }

    private fun primary(s: String, onClick: () -> Unit) = button(s, R.color.indigo, R.color.on_indigo, onClick)
    private fun secondary(s: String, onClick: () -> Unit) = button(s, R.color.surface2, R.color.ink, onClick)

    private fun card(title: String, body: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = rounded(R.color.surface, 16)
        setPadding(dp(16), dp(14), dp(16), dp(16))
        addView(label(title, 16f, R.color.ink, true))
        addView(label(body, 14.5f, R.color.ink2).apply { setPadding(0, dp(4), 0, 0) })
    }

    private fun callout(text: String) = label(text, 14.5f, R.color.red).apply {
        background = rounded(R.color.surface, 12)
        setPadding(dp(14), dp(12), dp(14), dp(12))
    }

    private fun row(title: String, ok: Boolean, help: String, action: String, onClick: () -> Unit): View {
        val r = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(R.color.surface, 14)
            setPadding(dp(14), dp(12), dp(8), dp(12))
        }
        r.addView(label(if (ok) "✓" else "•", 18f, if (ok) R.color.green else R.color.amber, true), LinearLayout.LayoutParams(dp(26), LinearLayout.LayoutParams.WRAP_CONTENT))
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(label(title, 15f, R.color.ink, true))
        col.addView(label(help, 13.5f, R.color.ink2))
        r.addView(col, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (!ok) {
            r.addView(Button(this).apply {
                text = action
                isAllCaps = false
                setTextColor(getColor(R.color.indigo_text))
                typeface = Typeface.DEFAULT_BOLD
                background = null
                setOnClickListener { onClick() }
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        return r
    }

    // Android 15 draws apps under the status and navigation bars: keep the content clear of them
    private fun padForBars(v: View, insets: WindowInsets) {
        if (Build.VERSION.SDK_INT >= 30) {
            val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
        } else {
            padForBarsOld(v, insets)
        }
    }

    @Suppress("DEPRECATION")
    private fun padForBarsOld(v: View, insets: WindowInsets) {
        v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
    }
}
