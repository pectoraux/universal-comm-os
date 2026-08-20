/**
 * core/policy/RoutingPolicy.ts
 */

import type { RoutingPolicy } from './types';

export const DEFAULT_POLICY_ID = 'default';

export function createRoutingPolicy(input: Partial<RoutingPolicy> & { policy_id: string; name: string }): RoutingPolicy {
  return {
    policy_id: input.policy_id,
    name: input.name,
    replication_factor: input.replication_factor ?? 1,
    max_hops: input.max_hops ?? 4,
    require_e2e: input.require_e2e ?? true,
    forbidden_transports: input.forbidden_transports ?? [],
    forbidden_gateways: input.forbidden_gateways ?? [],
    emergency_only: input.emergency_only ?? false,
    min_peer_verification: input.min_peer_verification ?? 'UNVERIFIED',
  };
}

export const defaultPolicy: RoutingPolicy = createRoutingPolicy({
  policy_id: DEFAULT_POLICY_ID,
  name: 'Default routing policy',
});

export function isTransportAllowed(policy: RoutingPolicy, transport: string): boolean {
  return !policy.forbidden_transports.includes(transport);
}

export function isGatewayAllowed(policy: RoutingPolicy, gateway: string): boolean {
  return !policy.forbidden_gateways.includes(gateway);
}
