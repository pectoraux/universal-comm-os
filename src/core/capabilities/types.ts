/**
 * core/capabilities/types.ts
 *
 * Node capabilities (ARCH-008). Routing reasons over capabilities,
 * NOT over device types.
 */

export type MessagingCapability = 'SEND' | 'RECEIVE';
export type TransportCapabilityType =
  | 'INTERNET'
  | 'WIFI'
  | 'BLE'
  | 'BLUETOOTH'
  | 'LAN'
  | 'WIFI_AWARE';
export type RelayCapability = 'STORE' | 'FORWARD';
export type GatewayCapabilityType =
  | 'MATRIX'
  | 'SMS'
  | 'EMAIL'
  | 'WHATSAPP'
  | 'TELEGRAM'
  | 'INSTAGRAM'
  | 'MESSENGER'
  | 'RCS';

export interface ResourceReport {
  bandwidth_bps?: number;
  storage_bytes?: number;
  battery_pct?: number; // 0..100
  compute_units?: number; // relative
  /** Timestamp the report was sampled. */
  sampled_at: number;
}

export interface NodeCapabilities {
  node_id: string;
  messaging: Set<MessagingCapability>;
  transport: Set<TransportCapabilityType>;
  relay: Set<RelayCapability>;
  gateway: Set<GatewayCapabilityType>;
  resource: ResourceReport;
  /** Advertised at. */
  advertised_at: number;
  /** Verification state of the advertisement (per THREAT_MODEL, capability honesty goal). */
  verification: 'UNVERIFIED' | 'PEER_CORROBORATED' | 'TRUSTED';
}

export type NodeRole = 'PERSONAL' | 'RELAY' | 'GATEWAY' | 'EDGE' | 'SERVICE';
