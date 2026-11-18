package app.tabi.trip

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.Base64
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Date
import java.util.concurrent.Executors

/**
 * Shares this phone's location with the trip while Tabi is closed: a foreground service (Android
 * shows its notification, with a Stop button) that posts to Tabi's OwnTracks address, the same one
 * the OwnTracks app uses, so the server needs nothing new.
 *
 * Battery: balanced accuracy (Wi-Fi and cell towers, GPS only when it's already on). A location is
 * sent when you've moved 25 m (at most every 30 seconds), and at least every 5 minutes when you
 * haven't, so friends never see you greyed out (Tabi greys people out after 15 minutes).
 *
 * TA-4: check-ins use an alarm on the real-time clock. A Handler timer counts only the time the
 * phone is awake, so in a pocket it hardly moved: a phone standing still went quiet, and one
 * paused because sharing was off in Tabi could stay paused for hours after it was turned on.
 */
class LocationService : Service() {
    companion object {
        const val ACTION_STOP = "app.tabi.trip.STOP"
        const val ACTION_PING = "app.tabi.trip.PING"
        private const val ONGOING = 7
        private const val ALERT = 8
        private const val UPDATE = 9
        private const val INTERVAL = 60_000L
        private const val FASTEST = 30_000L
        private const val MOVE_METRES = 25f
        private const val KEEP_FRESH = 5 * 60_000L
        private const val CHECK_IN = 10 * 60_000L

        @Volatile
        var running = false
            private set

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, LocationService::class.java))
        }

        /** Start sharing if it isn't running, and send a location now (opening Tabi does this). */
        fun ping(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, LocationService::class.java).setAction(ACTION_PING))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, LocationService::class.java))
        }

        fun channels(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
            nm.createNotificationChannel(NotificationChannel("sharing", "Location sharing", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Tabi shares your location, with a button to stop"
                setShowBadge(false)
            })
            nm.createNotificationChannel(NotificationChannel("alerts", "Problems and updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "When sharing stops on its own, or a new version of the app is ready"
            })
        }
    }

    private lateinit var cfg: Config
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var fused: FusedLocationProviderClient? = null
    private var manager: LocationManager? = null
    private var updating = false
    private var paused = false

    @Volatile private var lastSent: Location? = null
    @Volatile private var lastSentAt = 0L
    @Volatile private var pending: Location? = null

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { onFix(it, "u", false) }
        }
    }

    // Every method spelled out: before Android 11 they weren't optional
    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) { onFix(location, "u", false) }
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }


    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        cfg = Config(this)
        channels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            cfg.enabled = false
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ONGOING, ongoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            else startForeground(ONGOING, ongoing())
        } catch (e: Exception) {
            cfg.lastResult = "no-permission"
            stopSelf()
            return START_NOT_STICKY
        }
        if (!cfg.enabled || !cfg.connected || !Perms.location(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        running = true
        if (!updating && !paused) beginUpdates()
        scheduleCheckIn()
        ping() // straight away (and on every check-in), so the group sees you as soon as it's switched on
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        endUpdates()
        cancelCheckIn()
        io.shutdown()
        super.onDestroy()
    }

    @SuppressLint("MissingPermission")
    private fun beginUpdates() {
        if (!Perms.location(this)) return
        updating = true
        if (Perms.playServices(this)) {
            try {
                val f = LocationServices.getFusedLocationProviderClient(this)
                // No minimum distance: a fix every minute even when still, so onFix can keep you fresh
                val req = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, INTERVAL)
                    .setMinUpdateIntervalMillis(FASTEST)
                    .build()
                f.requestLocationUpdates(req, callback, Looper.getMainLooper())
                fused = f
                return
            } catch (e: Exception) {
                // fall through to the phone's own location service
            }
        }
        val m = getSystemService(LocationManager::class.java) ?: return
        manager = m
        for (p in listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)) {
            try {
                if (m.isProviderEnabled(p)) m.requestLocationUpdates(p, INTERVAL, 0f, listener, Looper.getMainLooper())
            } catch (e: Exception) {
            }
        }
    }

    private fun endUpdates() {
        try { fused?.removeLocationUpdates(callback) } catch (e: Exception) { }
        try { manager?.removeUpdates(listener) } catch (e: Exception) { }
        fused = null
        manager = null
        updating = false
    }

    // Wakes the service every 10 minutes of real time, asleep or not (Android may stretch it a little in deep sleep)
    private fun checkInIntent() = PendingIntent.getService(this, 5,
        Intent(this, LocationService::class.java).setAction(ACTION_PING), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun scheduleCheckIn() {
        try {
            getSystemService(AlarmManager::class.java)?.setAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + CHECK_IN, checkInIntent())
        } catch (e: Exception) {
        }
    }

    private fun cancelCheckIn() {
        try { getSystemService(AlarmManager::class.java)?.cancel(checkInIntent()) } catch (e: Exception) { }
    }

    /** A fresh location right now (on start, when Tabi opens, and on every check-in). */
    @SuppressLint("MissingPermission")
    private fun ping() {
        if (!Perms.location(this)) return
        if (Perms.playServices(this)) {
            try {
                LocationServices.getFusedLocationProviderClient(this)
                    .getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
                    .addOnSuccessListener { loc: Location? ->
                        if (loc != null) onFix(loc, "p", true) else pending?.let { send(it, "p") }
                    }
                return
            } catch (e: Exception) {
            }
        }
        val m = getSystemService(LocationManager::class.java) ?: return
        var best: Location? = null
        for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            val l = try { m.getLastKnownLocation(p) } catch (e: Exception) { null }
            if (l != null && (best == null || l.time > best.time)) best = l
        }
        best?.let { onFix(it, "p", true) }
    }

    private fun onFix(loc: Location, trigger: String, force: Boolean) {
        val prev = lastSent
        if (!force && prev != null) {
            val since = System.currentTimeMillis() - lastSentAt
            val moved = loc.distanceTo(prev) >= MOVE_METRES
            if (since < FASTEST || (!moved && since < KEEP_FRESH)) {
                pending = loc
                return
            }
        }
        send(loc, trigger)
    }

    private fun send(loc: Location, trigger: String) {
        if (io.isShutdown) return
        try { io.execute { post(loc, trigger) } } catch (e: Exception) { }
    }

    // OwnTracks' JSON format: https://owntracks.org/booklet/tech/json/
    private fun post(loc: Location, trigger: String) {
        val user = cfg.user ?: return
        val token = cfg.token ?: return
        val body = JSONObject()
        body.put("_type", "location")
        body.put("lat", loc.latitude)
        body.put("lon", loc.longitude)
        if (loc.hasAccuracy()) body.put("acc", Math.round(loc.accuracy))
        if (loc.hasAltitude()) body.put("alt", Math.round(loc.altitude))
        if (loc.hasSpeed()) body.put("vel", Math.round(loc.speed * 3.6f))
        if (loc.hasBearing()) body.put("cog", Math.round(loc.bearing))
        body.put("tst", loc.time / 1000L)
        battery()?.let { body.put("batt", it) }
        body.put("conn", connection())
        body.put("t", trigger)
        body.put("tid", user.filter { it.isLetterOrDigit() }.take(2).uppercase().ifEmpty { "TA" })

        val gate = cfg.gate
        val address = "https://${cfg.host}/api/owntracks" + (if (gate.isNullOrBlank()) "" else "?gate=" + Uri.encode(gate))
        var result = "error"
        cfg.lastTryAt = System.currentTimeMillis()
        try {
            val c = URL(address).openConnection() as HttpURLConnection
            try {
                c.requestMethod = "POST"
                c.connectTimeout = 15_000
                c.readTimeout = 20_000
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.setRequestProperty("Authorization", "Basic " + Base64.encodeToString("$user:$token".toByteArray(), Base64.NO_WRAP))
                c.setRequestProperty("User-Agent", "TabiAndroid/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE})")
                c.setRequestProperty("X-Limit-D", "tabi-android")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = c.responseCode
                cfg.lastCode = code
                cfg.lastError = null
                try { (if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes() } } catch (e: Exception) { }
                if (code in 200..299) {
                    lastSent = loc
                    lastSentAt = System.currentTimeMillis()
                    pending = null
                    cfg.lastOkAt = lastSentAt
                    val off = c.getHeaderField("X-Tabi-Sharing") == "off"
                    result = if (off) "paused" else "ok"
                    c.getHeaderField("X-Tabi-App-Latest")?.toIntOrNull()?.let { latest -> main.post { offerUpdate(latest) } }
                    main.post { setPaused(off) }
                } else if (code == 401 || code == 404) {
                    result = if (code == 401) "bad-token" else "gone"
                } else {
                    pending = loc
                }
            } finally {
                c.disconnect()
            }
        } catch (e: Exception) {
            pending = loc
            result = "offline"
            cfg.lastCode = 0
            cfg.lastError = (e.javaClass.simpleName + ": " + (e.message ?: "")).take(160)
        }
        cfg.lastResult = result
        main.post {
            if (result == "bad-token" || result == "gone") stopWithProblem() else refresh()
        }
    }

    // "Share my location" is off in Tabi: stop asking for locations, but check in now and then to notice it coming back on
    private fun setPaused(off: Boolean) {
        if (off && !paused) {
            paused = true
            endUpdates()
        } else if (!off && paused) {
            paused = false
            if (!updating) beginUpdates()
        }
    }

    private fun battery(): Int? {
        val bm = getSystemService(BatteryManager::class.java) ?: return null
        val v = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (v in 0..100) v else null
    }

    private fun connection(): String {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return "o"
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "o"
        return if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) "w" else "m"
    }

    private fun refresh() {
        if (!running) return
        try { getSystemService(NotificationManager::class.java)?.notify(ONGOING, ongoing()) } catch (e: Exception) { }
    }

    private fun ongoing(): Notification {
        val open = PendingIntent.getActivity(this, 1, Intent(this, SetupActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 2, Intent(this, LocationService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val text = when (cfg.lastResult) {
            "paused" -> "Paused: “Share my location” is off in Tabi"
            "offline" -> "Waiting for a connection"
            else -> if (cfg.lastOkAt > 0) "Last shared at " + DateFormat.getTimeFormat(this).format(Date(cfg.lastOkAt)) else "Finding you…"
        }
        val b = Notification.Builder(this, "sharing")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Sharing your location with the trip")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setColor(getColor(R.color.icon_bg))
            .addAction(Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_notification), "Stop sharing", stop).build())
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return b.build()
    }

    // The server no longer accepts this phone (a new token, or the person left the trip): stop and say so
    private fun stopWithProblem() {
        cfg.enabled = false
        val open = PendingIntent.getActivity(this, 3, Intent(this, SetupActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(this, "alerts")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Tabi stopped sharing your location")
            .setContentText("This phone needs connecting again. Open Tabi, then Settings › Location.")
            .setStyle(Notification.BigTextStyle().bigText("This phone needs connecting again. Open Tabi, go to Settings › Location and tap “Set up background sharing”."))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(getColor(R.color.icon_bg))
            .build()
        try { getSystemService(NotificationManager::class.java)?.notify(ALERT, n) } catch (e: Exception) { }
        stopSelf()
    }

    private fun offerUpdate(latest: Int) {
        if (latest <= BuildConfig.VERSION_CODE || cfg.notifiedCode >= latest) return
        cfg.notifiedCode = latest
        val open = PendingIntent.getActivity(this, 4,
            Intent(this, TwaActivity::class.java).setData(Uri.parse("https://${cfg.host}/#android-app")),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(this, "alerts")
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("An update to the Tabi app is ready")
            .setContentText("Tap to download it from Tabi.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(getColor(R.color.icon_bg))
            .build()
        try { getSystemService(NotificationManager::class.java)?.notify(UPDATE, n) } catch (e: Exception) { }
    }
}
