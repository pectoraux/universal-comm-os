/**
 * core/delivery/types.ts
 *
 * Delivery state machine (ARCH-012).
 * `sent = true` is FORBIDDEN as a delivery model.
 */

export type DeliveryState =
  | 'CREATED'
  | 'ACCEPTED'
  | 'QUEUED'
  | 'RELAYED'
  | 'GATEWAY_REACHED'
  | 'EXTERNAL_ACCEPTED'
  | 'DELIVERED'
  | 'READ';

export type DeliveryFailure =
  | 'EXPIRED'
  | 'REJECTED'
  | 'POLICY_BLOCKED'
  | 'NO_ROUTE'
  | 'CHANNEL_UNAVAILABLE'
  | 'GATEWAY_UNAVAILABLE'
  | 'DESTINATION_UNKNOWN';

export interface DeliveryEvent {
  ts: number;
  from?: DeliveryState | DeliveryFailure;
  to: DeliveryState | DeliveryFailure;
  node?: string; // node id (if known)
  transport?: string; // transport id (if relevant)
  note?: string;
}

export interface DeliveryRecord {
  bundle_id: string;
  current: DeliveryState | DeliveryFailure;
  history: DeliveryEvent[];
  updated_at: number;
}
