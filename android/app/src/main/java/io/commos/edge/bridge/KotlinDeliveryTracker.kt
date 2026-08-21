package io.commos.edge.bridge

/**
 * P4.1-B-H — Kotlin port of the canonical DeliveryTracker.
 *
 * H3 — This is the SOLE authority for delivery-state transitions in the
 * Android runtime. No Android component (service, store, adapter, callback)
 * may mutate delivery state without going through this class.
 *
 * The FORWARD_GRAPH and canTransition() logic are identical to the TypeScript
 * implementation in src/core/delivery/DeliveryTracker.ts. Conformance is
 * verified by cross-implementation tests: same input sequence → same
 * DeliveryEvent records.
 *
 * Article VI — the delivery state machine is frozen. This Kotlin class
 * implements the SAME state machine — it does NOT redefine it.
 */
class KotlinDeliveryTracker {

    data class DeliveryEvent(
        val ts: Long,
        val from: String?,
        val to: String,
        val node: String? = null,
        val transport: String? = null,
        val note: String? = null
    )

    data class DeliveryRecord(
        val bundleId: String,
        val current: String,
        val history: List<DeliveryEvent>,
        val updatedAt: Long
    )

    // Same FORWARD_GRAPH as TypeScript (src/core/delivery/DeliveryTracker.ts).
    private val FORWARD_GRAPH: Map<String, List<String>> = mapOf(
        "CREATED" to listOf("ACCEPTED"),
        "ACCEPTED" to listOf("QUEUED", "RELAYED"),
        "QUEUED" to listOf("RELAYED"),
        "RELAYED" to listOf("GATEWAY_REACHED", "EXTERNAL_ACCEPTED", "DELIVERED"),
        "GATEWAY_REACHED" to listOf("EXTERNAL_ACCEPTED"),
        "EXTERNAL_ACCEPTED" to listOf("DELIVERED"),
        "DELIVERED" to listOf("READ"),
        "READ" to emptyList()
    )

    private val FAILURE_STATES = setOf(
        "EXPIRED", "REJECTED", "POLICY_BLOCKED", "NO_ROUTE",
        "CHANNEL_UNAVAILABLE", "GATEWAY_UNAVAILABLE", "DESTINATION_UNKNOWN"
    )

    private val records = mutableMapOf<String, DeliveryRecord>()

    fun canTransition(from: String?, to: String): Boolean {
        if (from == null) return to == "CREATED"
        if (from in FAILURE_STATES) return false // terminal
        if (to in FAILURE_STATES) return true // any live state → failure
        return FORWARD_GRAPH[from]?.contains(to) ?: false
    }

    fun init(bundleId: String, ts: Long = System.currentTimeMillis()): DeliveryRecord {
        val rec = DeliveryRecord(
            bundleId = bundleId,
            current = "CREATED",
            history = listOf(DeliveryEvent(ts = ts, from = null, to = "CREATED")),
            updatedAt = ts
        )
        records[bundleId] = rec
        return rec
    }

    fun transition(
        bundleId: String,
        to: String,
        opts: Map<String, String> = emptyMap(),
        ts: Long = System.currentTimeMillis()
    ): DeliveryRecord {
        val rec = records[bundleId]
            ?: throw IllegalStateException("KotlinDeliveryTracker: unknown bundle $bundleId")
        if (!canTransition(rec.current, to)) {
            throw IllegalStateException(
                "KotlinDeliveryTracker: illegal transition ${rec.current} -> $to for $bundleId"
            )
        }
        val evt = DeliveryEvent(
            ts = ts,
            from = rec.current,
            to = to,
            node = opts["node"],
            transport = opts["transport"],
            note = opts["note"]
        )
        val next = DeliveryRecord(
            bundleId = bundleId,
            current = to,
            history = rec.history + evt,
            updatedAt = ts
        )
        records[bundleId] = next
        return next
    }

    fun get(bundleId: String): DeliveryRecord? = records[bundleId]
    fun has(bundleId: String): Boolean = records.containsKey(bundleId)
    fun snapshot(): List<DeliveryRecord> = records.values.toList()
    fun reset() { records.clear() }
}
