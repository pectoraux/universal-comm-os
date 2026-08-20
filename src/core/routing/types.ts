/**
 * core/routing/types.ts
 *
 * Routing abstractions (ARCH-008). Routes are ordered plans across hops.
 */

import type { TransportCapabilityType, GatewayCapabilityType } from '@/core/capabilities/types';
import type { Intent } from '@/core/intent/types';

export type RouteHopKind =
  | 'TRANSPORT' // direct P2P over a transport (BLE, Wi-Fi, LAN, Internet)
  | 'RELAY' // store-and-forward via an intermediate node
  | 'GATEWAY'; // cross-network egress via a gateway capability

export interface RouteHop {
  kind: RouteHopKind;
  /** Node id of the next hop (relay/gateway/recipient). */
  to_node_id?: string;
  transport?: TransportCapabilityType;
  gateway?: GatewayCapabilityType;
  /** Estimated delivery probability for the remainder of the route from this hop. */
  est_reliability?: number;
  /** Estimated additional latency (ms) contributed by this hop. */
  est_latency_ms?: number;
  /** Estimated additional cost (abstract units) contributed by this hop. */
  est_cost?: number;
}

export interface RoutePlan {
  bundle_id: string;
  /** Ordered list of hops. Empty list means "no route found". */
  hops: RouteHop[];
  /** Reason for the chosen plan, useful for observability. */
  rationale: string;
  /** Estimated end-to-end delivery probability. */
  est_reliability: number;
  /** Estimated end-to-end latency in ms. */
  est_latency_ms: number;
  /** Estimated end-to-end cost in abstract units. */
  est_cost: number;
  created_at: number;
}

export interface RouteDecision {
  status: 'ROUTE_FOUND' | 'NO_ROUTE' | 'PARTIAL';
  plan?: RoutePlan;
  reason: string;
}

export interface RoutingContext {
  intent: Intent;
  sender_node_id: string;
  /** Capabilities of the immediate peers this node can reach. */
  known_peers: PeerCapabilities[];
  /** Destination hint, if known. */
  destination?: {
    node_id?: string;
    channel?: string;
    channel_id?: string;
    identity_id?: string;
  };
}

export interface PeerCapabilities {
  node_id: string;
  transport: TransportCapabilityType[];
  relay: ('STORE' | 'FORWARD')[];
  gateway: GatewayCapabilityType[];
  resource?: {
    bandwidth_bps?: number;
    battery_pct?: number;
  };
  verification: 'UNVERIFIED' | 'PEER_CORROBORATED' | 'TRUSTED';
}
