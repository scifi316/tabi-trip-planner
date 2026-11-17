package app.tabi.trip

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager

object Perms {
    private fun has(ctx: Context, p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    fun location(ctx: Context) = has(ctx, Manifest.permission.ACCESS_FINE_LOCATION) || has(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
    fun precise(ctx: Context) = has(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
    fun background(ctx: Context) = Build.VERSION.SDK_INT < 29 || has(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    fun notifications(ctx: Context) = Build.VERSION.SDK_INT < 33 || has(ctx, Manifest.permission.POST_NOTIFICATIONS)
    fun battery(ctx: Context): Boolean {
        val pm = ctx.getSystemService(PowerManager::class.java) ?: return true
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }
    fun playServices(ctx: Context) = try {
        ctx.packageManager.getPackageInfo("com.google.android.gms", 0)
        true
    } catch (e: Exception) {
        false
    }
}
