package io.commos.edge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * P4.1-B — Real Android Foreground Service hosting the CommOS runtime.
 *
 * ARCH-054 (Android runtime lifecycle is canonical):
 *   CREATED → INITIALIZING → HYDRATING → RUNNING → DRAINING → STOPPED
 *
 * This service owns the Android lifecycle. It is NOT a second delivery state
 * machine — per-bundle delivery is owned by DeliveryTracker.transition()
 * (Article VI). The service's lifecycle maps to the ARCH-054 lifecycle:
 *
 *   onCreate()           → CREATED → INITIALIZING → HYDRATING
 *   onUnbind()/onDestroy() → DRAINING → STOPPED
 *
 * R1 — Process death recovery: the service re-hydrates from the Room
 *      database on restart (RoomBundleStore.snapshot()).
 * R2 — Background execution: foreground service, persistent notification.
 * R5 — Callback ownership: all coroutines + timers are owned by
 *      serviceScope; on destroy, all are cancelled.
 * R6 — Concurrency safety: single CoroutineScope (Dispatchers.Default),
 *      no concurrent state mutations.
 */
class CommOsService : Service() {

    companion object {
        const val CHANNEL_ID = "commos_runtime"
        const val NOTIFICATION_ID = 1

        // The current lifecycle state (observable for tests).
        // AtomicReference for R6 — concurrency safety.
        val lifecycleState = AtomicReference("CREATED")
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ttlSweeperJob: Job? = null
    private var resourceSamplerJob: Job? = null

    // The runtime host (from P4.1-A, re-hydrated on startup).
    private var runtimeHost: CommOsRuntimeBridge? = null

    override fun onCreate() {
        super.onCreate()

        // Create notification channel (Android 8.0+).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "CommOS Runtime",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Manages offline communication bundles"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }

        // Start as foreground service (R2 — background execution).
        startForeground(NOTIFICATION_ID, createNotification())

        // Lifecycle: CREATED → INITIALIZING → HYDRATING
        lifecycleState.set("INITIALIZING")

        serviceScope.launch {
            try {
                // R3 — deterministic rehydration from durable state ONLY.
                // NOT from BLE/network/UI callbacks.
                lifecycleState.set("HYDRATING")
                runtimeHost = CommOsRuntimeBridge(applicationContext)
                runtimeHost?.hydrate()

                // Lifecycle: HYDRATING → RUNNING
                lifecycleState.set("RUNNING")

                // R2 — start background work (TTL sweeper + resource sampling).
                startBackgroundWork()
            } catch (e: Exception) {
                // Fail-closed — the runtime is NOT in RUNNING state.
                lifecycleState.set("STOPPED")
            }
        }
    }

    /**
     * R2 — Background execution: TTL sweeper (60s) + resource sampler (30s).
     * All work is owned by serviceScope (R5 — callback ownership).
     */
    private fun startBackgroundWork() {
        // TTL sweeper — transitions QUEUED bundles to EXPIRED via the
        // canonical DeliveryTracker.transition() (R7 — delivery authority).
        ttlSweeperJob = serviceScope.launch {
            while (lifecycleState.get() == "RUNNING") {
                delay(60_000)
                runtimeHost?.runTtlSweeper()
            }
        }

        // Resource sampler — observations only, NOT protocol state
        // (Article XVIII §7).
        resourceSamplerJob = serviceScope.launch {
            while (lifecycleState.get() == "RUNNING") {
                delay(30_000)
                runtimeHost?.sampleResources()
            }
        }
    }

    override fun onUnbind(intent: Intent?): Boolean {
        // Lifecycle: RUNNING → DRAINING → STOPPED
        shutdown()
        return false
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    /**
     * R5 — Callback ownership: releases all coroutines, timers,
     * persistence handles, transport registrations.
     */
    private fun shutdown() {
        lifecycleState.set("DRAINING")
        ttlSweeperJob?.cancel()
        resourceSamplerJob?.cancel()
        runtimeHost?.close()
        serviceScope.cancel()
        lifecycleState.set("STOPPED")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotification(): Notification {
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("CommOS is running")
            .setContentText("Managing offline communication bundles")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
        return builder.build()
    }
}
