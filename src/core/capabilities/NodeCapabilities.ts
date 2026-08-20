/**
 * core/capabilities/NodeCapabilities.ts
 *
 * Capability advertisement helpers (ARCH-018): a node is NOT a gateway
 * merely because it has Internet. Capabilities must be explicit and policy-controlled.
 */

import type {
  GatewayCapabilityType,
  MessagingCapability,
  NodeCapabilities,
  NodeRole,
  RelayCapability,
  ResourceReport,
  TransportCapabilityType,
} from './types';

export interface CreateCapabilitiesInput {
  node_id: string;
  messaging?: MessagingCapability[];
  transport?: TransportCapabilityType[];
  relay?: RelayCapability[];
  gateway?: GatewayCapabilityType[];
  resource?: Partial<ResourceReport>;
  verification?: NodeCapabilities['verification'];
}

export function advertiseCapabilities(input: CreateCapabilitiesInput): NodeCapabilities {
  return {
    node_id: input.node_id,
    messaging: new Set(input.messaging ?? []),
    transport: new Set(input.transport ?? []),
    relay: new Set(input.relay ?? []),
    gateway: new Set(input.gateway ?? []),
    resource: {
      bandwidth_bps: input.resource?.bandwidth_bps,
      storage_bytes: input.resource?.storage_bytes,
      battery_pct: input.resource?.battery_pct,
      compute_units: input.resource?.compute_units,
      sampled_at: input.resource?.sampled_at ?? Date.now(),
    },
    advertised_at: Date.now(),
    verification: input.verification ?? 'UNVERIFIED',
  };
}

/**
 * Derive the set of roles a node plays, from its capabilities.
 * A node MAY hold multiple roles (a personal phone that also relays).
 */
export function deriveRoles(c: NodeCapabilities): NodeRole[] {
  const roles: NodeRole[] = [];
  if (c.gateway.size > 0) roles.push('GATEWAY');
  if (c.relay.has('STORE') || c.relay.has('FORWARD')) roles.push('RELAY');
  if (c.messaging.size > 0 && roles.length === 0) roles.push('PERSONAL');
  if (c.transport.has('LAN') && c.messaging.size > 0) roles.push('EDGE');
  if (roles.length === 0) roles.push('SERVICE');
  return roles;
}

export function canStore(c: NodeCapabilities): boolean {
  return c.relay.has('STORE');
}

export function canForward(c: NodeCapabilities): boolean {
  return c.relay.has('FORWARD');
}

export function isGateway(c: NodeCapabilities): boolean {
  return c.gateway.size > 0;
}

export function hasTransport(
  c: NodeCapabilities,
  t: TransportCapabilityType,
): boolean {
  return c.transport.has(t);
}

export function hasGateway(
  c: NodeCapabilities,
  g: GatewayCapabilityType,
): boolean {
  return c.gateway.has(g);
}
