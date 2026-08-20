/**
 * core/transport/Transport.ts
 *
 * The Transport INTERFACE — lives in core (Architecture Constitution Article I.2).
 * Implementations live in src/transport/* (loopback, lan, internet, dtn, ...).
 *
 * This interface is the only surface a transport exposes to core.
 * Transports receive opaque CommunicationBundles; they never decrypt them.
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type {
  TransportCapabilityType,
} from '@/core/capabilities/types';

export interface TransportHandshake {
  transport_id: string;
  peer_node_id: string;
  capabilities: TransportCapabilityType[];
}

export interface Transport {
  readonly transport_id: string;
  readonly transport_type: TransportCapabilityType;

  /** Whether the transport is currently usable (e.g. radio on, link up). */
  isAvailable(): boolean;

  /** Send a bundle to a peer node known by this transport. */
  send(bundle: CommunicationBundle, to_node_id: string): Promise<TransportSendResult>;

  /** Register a handler invoked when a bundle arrives. */
  onReceive(handler: (bundle: CommunicationBundle, from_node_id: string) => void): void;

  /** Graceful shutdown. */
  close?(): Promise<void>;
}

export type TransportSendResult =
  | { kind: 'OK'; forwarded_at: number }
  | { kind: 'UNAVAILABLE'; reason: string }
  | { kind: 'NO_PEER'; reason: string }
  | { kind: 'ERROR'; reason: string };
