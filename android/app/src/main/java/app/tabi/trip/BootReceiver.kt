package app.tabi.trip

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a restart (or an app update), carry on sharing if it was on. Needs "Allow all the time". */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val cfg = Config(context)
        if (!cfg.enabled || !cfg.connected || !Perms.location(context) || !Perms.background(context)) return
        try {
            LocationService.start(context)
        } catch (e: Exception) {
            // Android refused to start it from the background; it starts again next time Tabi is opened
        }
    }
}
