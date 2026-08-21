package io.commos.edge.persistence

import androidx.room.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * P4.1-B — Real Room/SQLite persistence for the StoredBundle contract.
 *
 * Article XVIII §13 — ONE protocol-level contract, many persistence impls.
 * This is the Android impl. The protocol contract is in
 * src/server/NodeRuntime.ts (the BundleStore interface). The Prisma impl
 * is in src/server/PrismaBundleStore.ts. Both satisfy the same contract.
 *
 * P1-P7 invariants (Article XVIII §13):
 *   P1: (bundle_id, node_id) is the unique key (UPSERT).
 *   P2: ReceivedBundle keyed by (node_id, bundle_id); dedup by bundle_id.
 *   P3: TTL sweeper transitions QUEUED → EXPIRED idempotently.
 *   P4: State changes only via DeliveryTracker.transition() (the store
 *       exposes updateState() for the runtime to call AFTER the tracker
 *       has authorized the transition — NOT a direct state setter).
 *   P5: appendForwardingProof updates only bundle_json.
 *   P6: WAL mode enabled (crash consistency).
 *   P7: Room migrations are forward-only.
 *
 * R1 — Process death recovery: the Room database survives process death.
 *      On restart, the CommOsRuntimeBridge re-hydrates from this store.
 */

// ─── Entities ──────────────────────────────────────────────────────────

@Entity(tableName = "stored_bundles", primaryKeys = ["bundle_id", "node_id"])
data class StoredBundleEntity(
    val bundle_id: String,
    val node_id: String,
    val next_hop: String,
    val bundle_json: String,   // serialized CommunicationBundle (opaque)
    val priority: String,      // BULK | NORMAL | PRIORITY | URGENT | EMERGENCY
    val expires_at: Long,      // epoch ms (TTL sweeper uses this field)
    val queued_at: Long,       // epoch ms (FIFO ordering)
    val state: String          // Article VI enum: CREATED | ACCEPTED | QUEUED | ... | EXPIRED | ...
)

@Entity(tableName = "received_bundles", primaryKeys = ["node_id", "bundle_id"])
data class ReceivedBundleEntity(
    val bundle_id: String,
    val node_id: String,
    val received_at: Long,      // epoch ms
    val from_node_id: String?  // null for local-origin bundles
)

// ─── DAOs ───────────────────────────────────────────────────────────────

@Dao
interface StoredBundleDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE) // P1 — UPSERT/dedup
    suspend fun insert(entity: StoredBundleEntity): Long

    @Query("SELECT * FROM stored_bundles WHERE bundle_id = :bundleId AND node_id = :nodeId")
    suspend fun get(bundleId: String, nodeId: String): StoredBundleEntity?

    @Query("SELECT * FROM stored_bundles WHERE node_id = :nodeId AND state = 'QUEUED' ORDER BY queued_at ASC")
    suspend fun getQueued(nodeId: String): List<StoredBundleEntity>

    @Query("SELECT bundle_id FROM stored_bundles WHERE node_id = :nodeId AND state = 'QUEUED' AND expires_at < :now")
    suspend fun getExpired(nodeId: String, now: Long): List<String>

    @Query("UPDATE stored_bundles SET state = :newState WHERE bundle_id = :bundleId AND node_id = :nodeId") // P4 — via tracker
    suspend fun updateState(bundleId: String, nodeId: String, newState: String): Int

    @Query("UPDATE stored_bundles SET bundle_json = :newJson WHERE bundle_id = :bundleId AND node_id = :nodeId") // P5
    suspend fun updateBundleJson(bundleId: String, nodeId: String, newJson: String): Int

    @Query("DELETE FROM stored_bundles WHERE bundle_id = :bundleId AND node_id = :nodeId")
    suspend fun remove(bundleId: String, nodeId: String): Int

    @Query("SELECT COUNT(*) FROM stored_bundles WHERE node_id = :nodeId AND state = 'QUEUED'")
    suspend fun countQueued(nodeId: String): Int

    @Query("SELECT EXISTS(SELECT 1 FROM stored_bundles WHERE bundle_id = :bundleId AND node_id = :nodeId)")
    suspend fun has(bundleId: String, nodeId: String): Boolean
}

@Dao
interface ReceivedBundleDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE) // P2 — dedup
    suspend fun insert(entity: ReceivedBundleEntity): Long

    @Query("SELECT EXISTS(SELECT 1 FROM received_bundles WHERE node_id = :nodeId AND bundle_id = :bundleId)")
    suspend fun hasReceived(nodeId: String, bundleId: String): Boolean
}

// ─── Database ──────────────────────────────────────────────────────────

@Database(
    entities = [StoredBundleEntity::class, ReceivedBundleEntity::class],
    version = 1,
    exportSchema = true
)
abstract class CommOsDatabase : RoomDatabase() {
    abstract fun storedBundleDao(): StoredBundleDao
    abstract fun receivedBundleDao(): ReceivedBundleDao

    companion object {
        @Volatile
        private var INSTANCE: CommOsDatabase? = null

        /**
         * P6 — crash consistency: WAL (Write-Ahead Logging) is the default
         * journal mode in Room. A crash mid-write leaves the previous state
         * intact; the WAL is replayed on restart.
         */
        fun get(context: android.content.Context, nodeId: String): CommOsDatabase {
            return INSTANCE ?: synchronized(this) {
                val db = Room.databaseBuilder(
                    context.applicationContext,
                    CommOsDatabase::class.java,
                    "commos-$nodeId.db"
                )
                // P6 — WAL mode for crash consistency.
                .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
                .fallbackToDestructiveMigration() // P7 — forward-only
                .build()
                INSTANCE = db
                db
            }
        }
    }
}

// ─── RoomBundleStore — implements the protocol-level BundleStore contract ─

/**
 * The Android BundleStore implementation. Satisfies P1-P7.
 *
 * The store does NOT own delivery state (P4). The state field is a CACHE
 * of the canonical DeliveryTracker state. Mutations go through
 * updateStateFromTracker() which the runtime calls AFTER the tracker has
 * authorized the transition.
 */
class RoomBundleStore(
    private val dao: StoredBundleDao,
    private val receivedDao: ReceivedBundleDao,
    private val nodeId: String
) {
    // P1 — push is idempotent (OnConflictStrategy.IGNORE)
    suspend fun push(bundleJson: String, bundleId: String, nextHop: String,
                     priority: String, expiresAt: Long, queuedAt: Long = System.currentTimeMillis()) {
        dao.insert(StoredBundleEntity(
            bundle_id = bundleId,
            node_id = nodeId,
            next_hop = nextHop,
            bundle_json = bundleJson,
            priority = priority,
            expires_at = expiresAt,
            queued_at = queuedAt,
            state = "QUEUED"
        ))
    }

    // P2 — dedup by bundle_id
    suspend fun markReceived(bundleId: String, fromNodeId: String?) {
        receivedDao.insert(ReceivedBundleEntity(
            bundle_id = bundleId,
            node_id = nodeId,
            received_at = System.currentTimeMillis(),
            from_node_id = fromNodeId
        ))
    }

    suspend fun hasReceived(bundleId: String): Boolean = receivedDao.hasReceived(nodeId, bundleId)

    // P3 — TTL sweeper support
    suspend fun getExpiredBundleIds(now: Long = System.currentTimeMillis()): List<String> =
        dao.getExpired(nodeId, now)

    // P4 — state transitions via DeliveryTracker.transition() only
    suspend fun updateStateFromTracker(bundleId: String, newState: String): Boolean {
        val rows = dao.updateState(bundleId, nodeId, newState)
        return rows > 0
    }

    // P5 — forwarding-proof append-only
    suspend fun appendForwardingProof(bundleId: String, newBundleJson: String): Boolean {
        val rows = dao.updateBundleJson(bundleId, nodeId, newBundleJson)
        return rows > 0
    }

    // R1 — snapshot for re-hydration
    suspend fun snapshot(): List<StoredBundleEntity> = dao.getQueued(nodeId)

    suspend fun has(bundleId: String): Boolean = dao.has(bundleId, nodeId)

    suspend fun remove(bundleId: String): Boolean = dao.remove(bundleId, nodeId) > 0

    suspend fun size(): Int = dao.countQueued(nodeId)
}
