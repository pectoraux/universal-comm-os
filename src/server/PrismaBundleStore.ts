/**
 * server/PrismaBundleStore.ts
 *
 * Persistent BundleStore implementation (ROADMAP P3.1, P3.3).
 *
 * - Survives process restarts (StoredBundle table).
 * - Deduplication across restarts via ReceivedBundle table (unique (node_id, bundle_id)).
 * - Delivery state events persisted to DeliveryEvent table for forensics.
 *
 * Conforms to the BundleStore interface defined in NodeRuntime.ts.
 * Architecture: lives in the SERVER layer. May import core/* and prisma client.
 */

import { db } from '@/lib/db';
import type { BundleStore } from '@/server/NodeRuntime';
import type { CommunicationBundle } from '@/core/bundle/types';

/**
 * Serialize a bundle to canonical JSON for storage.
 * We deliberately do NOT store the plaintext — only the encrypted envelope.
 * (THREAT_MODEL §1: payload confidentiality; THREAT_MODEL §11: metadata minimization.)
 */
function serializeBundle(bundle: CommunicationBundle): string {
  return JSON.stringify({
    bundle_id: bundle.bundle_id,
    sender: bundle.sender,
    recipient: bundle.recipient,
    conversation_id: bundle.conversation_id,
    intent: bundle.intent,
    created_at: bundle.created_at,
    expires_at: bundle.expires_at,
    priority: bundle.priority,
    routing_policy: bundle.routing_policy,
    encryption_metadata: bundle.encryption_metadata,
    payload: bundle.payload,
    delivery_requirements: bundle.delivery_requirements,
    proofs: bundle.proofs,
  });
}

export function deserializeBundle(json: string): CommunicationBundle {
  const obj = JSON.parse(json);
  return Object.freeze({
    bundle_id: obj.bundle_id,
    sender: obj.sender,
    recipient: obj.recipient,
    conversation_id: obj.conversation_id,
    intent: obj.intent,
    created_at: obj.created_at,
    expires_at: obj.expires_at,
    priority: obj.priority,
    routing_policy: obj.routing_policy,
    encryption_metadata: obj.encryption_metadata,
    payload: obj.payload,
    delivery_requirements: obj.delivery_requirements,
    proofs: obj.proofs ?? [],
  }) as CommunicationBundle;
}

export interface PrismaBundleStoreOptions {
  node_id: string;
}

export function createPrismaBundleStore(opts: PrismaBundleStoreOptions): BundleStore {
  const { node_id } = opts;

  return {
    async push(bundle: CommunicationBundle, nextHop: string, ts: number = Date.now()) {
      // Dedup at the SQL layer: if (node_id, bundle_id) is already in ReceivedBundle,
      // we ignore the push.
      try {
        // First, record that we've seen this bundle. Unique constraint protects us.
        await db.receivedBundle.create({
          data: {
            bundle_id: bundle.bundle_id,
            node_id,
            received_at: ts,
            from_node_id: null, // unknown at push time
          },
        });
      } catch {
        // Unique constraint violation = already seen.
        return;
      }

      // Persist the bundle for store-and-forward.
      try {
        await db.storedBundle.create({
          data: {
            bundle_id: bundle.bundle_id,
            node_id,
            next_hop: nextHop,
            bundle_json: serializeBundle(bundle),
            priority: bundle.priority,
            expires_at: bundle.expires_at,
            queued_at: ts,
            state: 'QUEUED',
          },
        });
      } catch {
        // If the bundle_id already exists in StoredBundle (rare: we just inserted into
        // ReceivedBundle in the same call), we silently no-op.
        return;
      }
    },

    async pop() {
      // Pop the oldest queued bundle for this node (FIFO).
      const row = await db.storedBundle.findFirst({
        where: { node_id, state: 'QUEUED' },
        orderBy: { queued_at: 'asc' },
      });
      if (!row) return undefined;
      // Mark as RELAYED (no longer QUEUED) so pop is idempotent under concurrency.
      await db.storedBundle.update({
        where: { bundle_id: row.bundle_id },
        data: { state: 'RELAYED' },
      });
      return {
        bundle: deserializeBundle(row.bundle_json),
        nextHop: row.next_hop,
        queued_at: row.queued_at,
      };
    },

    async size() {
      return db.storedBundle.count({ where: { node_id, state: 'QUEUED' } });
    },

    async peek() {
      const rows = await db.storedBundle.findMany({
        where: { node_id, state: 'QUEUED' },
        orderBy: { queued_at: 'asc' },
      });
      return rows.map((r) => ({
        bundle: deserializeBundle(r.bundle_json),
        nextHop: r.next_hop,
        queued_at: r.queued_at,
      }));
    },

    async remove(bundle_id: string) {
      const row = await db.storedBundle.findUnique({ where: { bundle_id } });
      if (!row) return false;
      await db.storedBundle.delete({ where: { bundle_id } });
      return true;
    },

    async has(bundle_id: string) {
      const r = await db.receivedBundle.findUnique({
        where: { node_id_bundle_id: { node_id, bundle_id } },
      });
      return r !== null;
    },
  };
}

/**
 * Per-node delivery state persistence. Writes a DeliveryEvent row for every
 * transition, supports reading the current state for a bundle from disk.
 */
export interface PersistedDeliveryTracker {
  recordTransition(input: {
    bundle_id: string;
    node_id: string;
    from?: string;
    to: string;
    ts: number;
    transport?: string;
    note?: string;
  }): Promise<void>;
  getDeliveryState(bundle_id: string, node_id: string): Promise<{ current: string; history: Array<{ from?: string; to: string; ts: number; transport?: string; note?: string }> } | undefined>;
  snapshot(node_id?: string): Promise<Array<{ bundle_id: string; node_id: string; current: string; history: Array<any> }>>;
}

export function createPrismaDeliveryTracker(): PersistedDeliveryTracker {
  return {
    async recordTransition({ bundle_id, node_id, from, to, ts, transport, note }) {
      await db.deliveryEvent.create({
        data: {
          bundle_id,
          node_id,
          from_state: from ?? null,
          to_state: to,
          ts,
          transport: transport ?? null,
          note: note ?? null,
        },
      });
    },

    async getDeliveryState(bundle_id, node_id) {
      const rows = await db.deliveryEvent.findMany({
        where: { bundle_id, node_id },
        orderBy: { ts: 'asc' },
      });
      if (rows.length === 0) return undefined;
      const last = rows[rows.length - 1];
      return {
        current: last.to_state,
        history: rows.map((r) => ({
          from: r.from_state ?? undefined,
          to: r.to_state,
          ts: r.ts,
          transport: r.transport ?? undefined,
          note: r.note ?? undefined,
        })),
      };
    },

    async snapshot(node_id) {
      const where = node_id ? { node_id } : {};
      const rows = await db.deliveryEvent.findMany({
        where,
        orderBy: { ts: 'asc' },
      });
      const byBundleNode = new Map<string, { bundle_id: string; node_id: string; current: string; history: any[] }>();
      for (const r of rows) {
        const key = `${r.node_id}|${r.bundle_id}`;
        let entry = byBundleNode.get(key);
        if (!entry) {
          entry = { bundle_id: r.bundle_id, node_id: r.node_id, current: r.to_state, history: [] };
          byBundleNode.set(key, entry);
        }
        entry.history.push({
          from: r.from_state ?? undefined,
          to: r.to_state,
          ts: r.ts,
          transport: r.transport ?? undefined,
          note: r.note ?? undefined,
        });
        entry.current = r.to_state;
      }
      return Array.from(byBundleNode.values());
    },
  };
}
