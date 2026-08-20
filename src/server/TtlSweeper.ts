/**
 * server/TtlSweeper.ts
 *
 * Background TTL expiry sweeper (ROADMAP P3.2).
 *
 * Protocol §10: "Bundle TTL is authoritative. After expiry, the bundle
 * MUST NOT be re-forwarded."
 *
 * ARCH-012: EXPIRED is a terminal failure state in the delivery machine.
 *
 * The sweeper periodically:
 *   - Scans all StoredBundle rows whose expires_at <= now.
 *   - Marks their persisted state as EXPIRED.
 *   - Optionally removes them from the queue (we keep the row for forensics,
 *     but mark it EXPIRED so pop() skips it).
 *   - Emits a DeliveryEvent transition to EXPIRED for each.
 *
 * The sweeper is owned by the singleton network (server/CommOS.ts) so there
 * is one sweeper per process.
 */

import { db } from '@/lib/db';

export interface TtlSweeper {
  start(): void;
  stop(): void;
  /** Run one sweep immediately (for tests + UI "Run sweep" button). */
  sweepOnce(): Promise<{ expired_count: number; ts: number }>;
  isRunning(): boolean;
  lastSweep(): { expired_count: number; ts: number } | undefined;
}

export function createTtlSweeper(interval_ms = 5_000): TtlSweeper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: { expired_count: number; ts: number } | undefined;

  async function sweepOnce(): Promise<{ expired_count: number; ts: number }> {
    const now = Date.now();
    // Find all queued bundles whose TTL has elapsed.
    const expired = await db.storedBundle.findMany({
      where: { expires_at: { lte: now }, state: 'QUEUED' },
    });
    let count = 0;
    for (const row of expired) {
      await db.storedBundle.update({
        where: { bundle_id: row.bundle_id },
        data: { state: 'EXPIRED' },
      });
      await db.deliveryEvent.create({
        data: {
          bundle_id: row.bundle_id,
          node_id: row.node_id,
          from_state: 'QUEUED',
          to_state: 'EXPIRED',
          ts: now,
          note: 'TTL elapsed',
        },
      });
      count++;
    }
    last = { expired_count: count, ts: now };
    return last;
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void sweepOnce().catch(() => {
          // Ignore transient DB errors; the next interval will retry.
        });
      }, interval_ms);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    sweepOnce,
    isRunning() {
      return timer !== null;
    },
    lastSweep() {
      return last;
    },
  };
}
