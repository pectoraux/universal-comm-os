/**
 * core/delivery/DeliveryTracker.ts
 *
 * Tracks the delivery state of a Communication Bundle.
 * Enforces the ARCH-012 state machine.
 */

import type {
  DeliveryEvent,
  DeliveryFailure,
  DeliveryRecord,
  DeliveryState,
} from './types';

/**
 * Legal forward transitions in the happy path. Anything else requires explicit
 * failure transitions (handled separately) or is rejected.
 */
const FORWARD_GRAPH: Record<DeliveryState, DeliveryState[]> = {
  CREATED: ['ACCEPTED'],
  ACCEPTED: ['QUEUED', 'RELAYED'],
  QUEUED: ['RELAYED'],
  RELAYED: ['GATEWAY_REACHED', 'EXTERNAL_ACCEPTED', 'DELIVERED'],
  GATEWAY_REACHED: ['EXTERNAL_ACCEPTED'],
  EXTERNAL_ACCEPTED: ['DELIVERED'],
  DELIVERED: ['READ'],
  READ: [],
};

/**
 * Any live DeliveryState may transition to a failure state (with some constraints).
 * Failure states are terminal for this tracker (no further forward transitions).
 */
const FAILURE_STATES: DeliveryFailure[] = [
  'EXPIRED',
  'REJECTED',
  'POLICY_BLOCKED',
  'NO_ROUTE',
  'CHANNEL_UNAVAILABLE',
  'GATEWAY_UNAVAILABLE',
  'DESTINATION_UNKNOWN',
];

function isFailure(s: string): s is DeliveryFailure {
  return (FAILURE_STATES as string[]).includes(s);
}

export function canTransition(
  from: DeliveryState | DeliveryFailure | undefined,
  to: DeliveryState | DeliveryFailure,
): boolean {
  if (from === undefined) {
    // Initial transition into CREATED always allowed.
    return to === 'CREATED';
  }
  if (isFailure(from)) return false; // terminal
  if (isFailure(to)) {
    // Any live state may transition to a failure state.
    return true;
  }
  return FORWARD_GRAPH[from as DeliveryState]?.includes(to as DeliveryState) ?? false;
}

export function createDeliveryTracker(): DeliveryTracker {
  const records = new Map<string, DeliveryRecord>();

  return {
    init(bundle_id: string, ts: number = Date.now()): DeliveryRecord {
      const rec: DeliveryRecord = {
        bundle_id,
        current: 'CREATED',
        history: [{ ts, to: 'CREATED' }],
        updated_at: ts,
      };
      records.set(bundle_id, rec);
      return rec;
    },

    transition(
      bundle_id: string,
      to: DeliveryState | DeliveryFailure,
      opts: { node?: string; transport?: string; note?: string } = {},
      ts: number = Date.now(),
    ): DeliveryRecord {
      const rec = records.get(bundle_id);
      if (!rec) throw new Error(`DeliveryTracker: unknown bundle ${bundle_id}`);
      if (!canTransition(rec.current, to)) {
        throw new Error(
          `DeliveryTracker: illegal transition ${rec.current} -> ${to} for ${bundle_id}`,
        );
      }
      const evt: DeliveryEvent = {
        ts,
        from: rec.current as DeliveryState | DeliveryFailure,
        to,
          node: opts.node,
          transport: opts.transport,
          note: opts.note,
      };
      const next: DeliveryRecord = {
        bundle_id,
        current: to,
        history: [...rec.history, evt],
        updated_at: ts,
      };
      records.set(bundle_id, next);
      return next;
    },

    get(bundle_id: string): DeliveryRecord | undefined {
      return records.get(bundle_id);
    },

    snapshot(): DeliveryRecord[] {
      return Array.from(records.values());
    },

    reset(): void {
      records.clear();
    },
  };
}

export interface DeliveryTracker {
  init(bundle_id: string, ts?: number): DeliveryRecord;
  transition(
    bundle_id: string,
    to: DeliveryState | DeliveryFailure,
    opts?: { node?: string; transport?: string; note?: string },
    ts?: number,
  ): DeliveryRecord;
  get(bundle_id: string): DeliveryRecord | undefined;
  snapshot(): DeliveryRecord[];
  reset(): void;
}
