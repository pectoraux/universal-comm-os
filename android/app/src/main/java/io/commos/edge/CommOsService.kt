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
 * P4.1-B-H — Real Android Foreground Service hosting the CommOS runtime.
 *
 * H6 FIX: Uses the canonical lifecycle transition mechanism (ARCH-054).
 * The service does NOT directly assign lifecycle strings — it calls
 * transitionLifecycle() which enforces the forward-only transitions.
 *
 * ARCH-054 (Android runtime lifecycle is canonical):
 *   CREATED → INITIALIZING → HYDRATING → RUNNING → DRAINING → STOPPED
 *
 * R1 — Process death recovery: the service re-hydrates from the Room
 *      database on restart (RoomBundleStore.snapshot()).
 * R2 — Background execution: foreground service, persistent notification.
 * R5 — Callback ownership: all coroutines owned by serviceScope; on
 *      destroy, all are cancelled.
 * R6 — Concurrency safety: single CoroutineScope (Dispatchers.Default).
 */
class CommOsService : Service() {

    companion object {
        const val CHANNEL_ID = "commos_runtime"
        const val NOTIFICATION_ID = 1
        val lifecycleState = AtomicReference("CREATED")
    }

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var ttlSweeperJob: Job? = null
    private var resourceSamplerJob: Job? = null
    private var runtimeBridge: io.commos.edge.bridge.CommOsRuntimeBridge? = null

    // H6 — canonical lifecycle transition function.
    // Same forward-only graph as the TypeScript ARCH-054 implementation.
    private fun transitionLifecycle(to: String): Boolean {
        val from = lifecycleState.get()
        val valid = when (from to to) {
            "CREATED" to "INITIALIZING" -> true
            "INITIALIZING" to "HYDRATING" -> true
            "HYDRATING" to "RUNNING" -> true
            "RUNNING" to "DRAINING" -> true
            "DRAINING" to "STOPPED" -> true
            else -> false // no skipping, no backward (ARCH-054)
        }
        if (!valid) return false
        lifecycleState.set(to)
        return true
    }

    override fun onCreate() {
        super.onCreate()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "CommOS Runtime",
                NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Manages offline communication bundles" }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }

        startForeground(NOTIFICATION_ID, createNotification())

        // H6 — CREATED → INITIALIZING (canonical transition)
        transitionLifecycle("INITIALIZING")

        serviceScope.launch {
            try {
                // R3 — deterministic rehydration from durable state ONLY.
                runtimeBridge = io.commos.edge.bridge.CommOsRuntimeBridge(applicationContext)
                // H6 — INITIALIZING → HYDRATING
                transitionLifecycle("HYDRATING")
                runtimeBridge?.hydrate() // R1, R3 — re-hydrate from Room DB

                // H6 — HYDRATING → RUNNING
                transitionLifecycle("RUNNING")

                // R2 — start background work
                startBackgroundWork()
            } catch (e: Exception) {
                // Fail-closed — runtime is NOT in RUNNING state.
                lifecycleState.set("STOPPED")
            }
        }
    }

    private fun startBackgroundWork() {
        ttlSweeperJob = serviceScope.launch {
            while (lifecycleState.get() == "RUNNING") {
                delay(60_000)
                runtimeBridge?.runTtlSweeper() // H3 — via DeliveryTracker
            }
        }
        resourceSamplerJob = serviceScope.launch {
            while (lifecycleState.get() == "RUNNING") {
                delay(30_000)
                runtimeBridge?.sampleResources() // H10 — observation only
            }
        }
    }

    override fun onUnbind(intent: Intent?): Boolean {
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
        // H6 — RUNNING → DRAINING → STOPPED (canonical transitions)
        transitionLifecycle("DRAINING")
        ttlSweeperJob?.cancel()
        resourceSamplerJob?.cancel()
        runtimeBridge?.close()
        serviceScope.cancel()
        transitionLifecycle("STOPPED")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotification(): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("CommOS is running")
            .setContentText("Managing offline communication bundles")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .build()
    }
}
