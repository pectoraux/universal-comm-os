/**
 * core/policy/types.ts
 *
 * Routing & delivery policy (ARCH-008, ARCH-020).
 */

export interface RoutingPolicy {
  policy_id: string;
  name: string;
  replication_factor: number;
  max_hops: number;
  require_e2e: boolean;
  /** Transports that are EXPLICITLY forbidden by policy. */
  forbidden_transports: string[];
  /** Gateways that are EXPLICITLY forbidden by policy. */
  forbidden_gateways: string[];
  /** Emergency-only policy? If true, suppress nonessential traffic. */
  emergency_only: boolean;
  /** Minimum capability verification level required of a peer. */
  min_peer_verification: 'UNVERIFIED' | 'PEER_CORROBORATED' | 'TRUSTED';
}
