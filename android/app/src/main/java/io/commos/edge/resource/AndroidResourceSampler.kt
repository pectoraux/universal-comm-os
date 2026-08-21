package io.commos.edge.resource

import android.content.Context
import android.os.BatteryManager
import android.os.StatFs
import java.io.File

/**
 * P4.1-B — Real Android resource sampler (ARCH-035 + Article XVIII §7).
 *
 * Resources are OBSERVATIONS, NOT protocol state. The sampler reads
 * battery / storage / connectivity from the platform and returns a
 * protocol-neutral report. The routing layer (ARCH-035) consumes it.
 *
 * Article XVIII §7: resource information MUST remain observation/capability,
 * NOT delivery state / identity state / trust state / authorization state.
 *
 * A `batteryLow` observation may influence capability/resource reporting
 * (e.g., the node advertises `relay: ['FORWARD']` instead of
 * `relay: ['STORE', 'FORWARD']`). It MUST NOT become `deliveryState = LOW_BATTERY`.
 */
class AndroidResourceSampler(private val context: Context) {

    data class ResourceReport(
        val batteryPct: Int,         // 0..100
        val storageFreeBytes: Long,  // free bytes on the data volume
        val isCharging: Boolean,
        val sampledAt: Long           // epoch ms
    )

    /**
     * Sample the current resource report from the Android platform.
     * Returns null if sampling fails (fail-safe, not fail-closed —
     * resource observations are best-effort, not security-critical).
     */
    fun sample(): ResourceReport? {
        return try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val batteryPct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val isCharging = bm.isCharging

            val dataDir = context.filesDir
            val stat = StatFs(dataDir.absolutePath)
            val freeBytes = stat.availableBytes

            ResourceReport(
                batteryPct = batteryPct,
                storageFreeBytes = freeBytes,
                isCharging = isCharging,
                sampledAt = System.currentTimeMillis()
            )
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Whether the sampler is available (the system services are ready).
     */
    fun isAvailable(): Boolean {
        return try {
            context.getSystemService(Context.BATTERY_SERVICE) != null
        } catch (e: Exception) {
            false
        }
    }
}
