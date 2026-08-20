/**
 * core/routing/Router.ts
 *
 * Capability- and policy-based routing (ARCH-008).
 *
 * Routes over capabilities, NOT device types:
 *   forbidden:  if (device_type === 'android') ...
 *   required:   if (node.capabilities.has('BLE'))
 *
 * The router MAY produce a single-hop route (e.g. direct Matrix) OR
 * a multi-hop DTN route (e.g. Bluetooth → Relay → Gateway → SMS).
 *
 * If no route can satisfy the intent's constraints, the router returns
 * an explicit `NO_ROUTE` decision.
 */

import type { RoutingPolicy } from '@/core/policy/types';
import type { RouteDecision, RouteHop, RoutePlan, RoutingContext } from './types';
import type { Intent } from '@/core/intent/types';
import type { TransportCapabilityType, GatewayCapabilityType } from '@/core/capabilities/types';
import { isTransportAllowed, isGatewayAllowed } from '@/core/policy/RoutingPolicy';

/**
 * Compute the rank of a route given the intent's constraints.
 * Higher is better. Returns null if the route violates hard constraints.
 */
function rankRoute(
  plan: { hops: RouteHop[]; est_reliability: number; est_latency_ms: number; est_cost: number },
  intent: Intent,
  policy: RoutingPolicy,
): number | null {
  if (plan.hops.length > policy.max_hops) return null;
  if (intent.min_reliability !== undefined && plan.est_reliability < intent.min_reliability)
    return null;
  if (intent.max_latency_ms !== undefined && plan.est_latency_ms > intent.max_latency_ms)
    return null;
  if (intent.max_cost !== undefined && plan.est_cost > intent.max_cost) return null;
  // Policy check: forbidden transports/gateways are excluded during planning, but double-check.
  for (const hop of plan.hops) {
    if (hop.transport && !isTransportAllowed(policy, hop.transport)) return null;
    if (hop.gateway && !isGatewayAllowed(policy, hop.gateway)) return null;
  }
  // Reliability dominates; latency is secondary; cost is tertiary.
  return plan.est_reliability * 1000 - plan.est_latency_ms / 10 - plan.est_cost;
}

function planHopsForPeer(
  ctx: RoutingContext,
  policy: RoutingPolicy,
): RouteHop[][] {
  const candidatePlans: RouteHop[][] = [];

  // 1. Direct transport hop if a peer IS the destination.
  const destNodeId = ctx.destination?.node_id;
  for (const peer of ctx.known_peers) {
    if (destNodeId === peer.node_id) {
      for (const t of peer.transport) {
        if (!isTransportAllowed(policy, t)) continue;
        candidatePlans.push([
          {
            kind: 'TRANSPORT',
            to_node_id: peer.node_id,
            transport: t,
            est_reliability: 0.95,
            est_latency_ms: peer.resource?.bandwidth_bps ? 1000 / peer.resource.bandwidth_bps : 50,
            est_cost: 1,
          },
        ]);
      }
    }
  }

  // 2. Direct GATEWAY hop if recipient is on a channel we have a gateway to.
  const destChannel = ctx.destination?.channel as GatewayCapabilityType | undefined;
  if (destChannel) {
    for (const peer of ctx.known_peers) {
      if (peer.gateway.includes(destChannel) && isGatewayAllowed(policy, destChannel)) {
        candidatePlans.push([
          {
            kind: 'GATEWAY',
            to_node_id: peer.node_id,
            gateway: destChannel,
            est_reliability: 0.85,
            est_latency_ms: 500,
            est_cost: 5,
          },
        ]);
      }
    }
  }

  // 3. Two-hop relay -> gateway plan, e.g. BLE -> Relay -> Gateway -> SMS.
  for (const relay of ctx.known_peers) {
    if (!relay.relay.includes('FORWARD')) continue;
    if (policy.min_peer_verification === 'PEER_CORROBORATED' && relay.verification === 'UNVERIFIED')
      continue;
    if (policy.min_peer_verification === 'TRUSTED' && relay.verification !== 'TRUSTED') continue;
    // The relay may have its own gateway capabilities, or it may forward to a third peer.
    for (const relayTransport of relay.transport) {
      if (!isTransportAllowed(policy, relayTransport)) continue;
      // 3a. Relay is also a gateway to dest channel.
      if (destChannel && relay.gateway.includes(destChannel) && isGatewayAllowed(policy, destChannel)) {
        candidatePlans.push([
          {
            kind: 'TRANSPORT',
            to_node_id: relay.node_id,
            transport: relayTransport,
            est_reliability: 0.7,
            est_latency_ms: 200,
            est_cost: 2,
          },
          {
            kind: 'GATEWAY',
            to_node_id: relay.node_id,
            gateway: destChannel,
            est_reliability: 0.85,
            est_latency_ms: 500,
            est_cost: 5,
          },
        ]);
      }
      // 3b. Relay -> another peer (forwarding).
      for (const gwPeer of ctx.known_peers) {
        if (gwPeer.node_id === relay.node_id) continue;
        if (!destChannel) continue;
        if (!gwPeer.gateway.includes(destChannel) || !isGatewayAllowed(policy, destChannel))
          continue;
        candidatePlans.push([
          {
            kind: 'RELAY',
            to_node_id: relay.node_id,
            transport: relayTransport,
            est_reliability: 0.65,
            est_latency_ms: 300,
            est_cost: 3,
          },
          {
            kind: 'GATEWAY',
            to_node_id: gwPeer.node_id,
            gateway: destChannel,
            est_reliability: 0.85,
            est_latency_ms: 500,
            est_cost: 5,
          },
        ]);
      }
    }
  }

  // 4. Direct hop to a peer — opportunistic delivery.
  //    a) No specific destination: send to any reachable peer.
  //    b) destChannel set but no peer advertised the matching gateway capability
  //       (we may simply lack gossiped capability info — P5 territory).
  //       Fall back to sending to the first reachable peer; the relay will
  //       re-route on receipt per P3.5 multi-hop forwarding.
  if (!destNodeId) {
    const opportunisticOk = !destChannel || candidatePlans.length === 0;
    if (opportunisticOk) {
      for (const peer of ctx.known_peers) {
        for (const t of peer.transport) {
          if (!isTransportAllowed(policy, t)) continue;
          candidatePlans.push([
            {
              kind: 'TRANSPORT',
              to_node_id: peer.node_id,
              transport: t,
              est_reliability: 0.7,
              est_latency_ms: 100,
              est_cost: 1,
            },
          ]);
        }
      }
    }
  }

  return candidatePlans;
}

function evaluatePlan(
  hops: RouteHop[],
): { est_reliability: number; est_latency_ms: number; est_cost: number } {
  let reliability = 1;
  let latency = 0;
  let cost = 0;
  for (const hop of hops) {
    reliability *= hop.est_reliability ?? 0.5;
    latency += hop.est_latency_ms ?? 100;
    cost += hop.est_cost ?? 1;
  }
  return { est_reliability: reliability, est_latency_ms: latency, est_cost: cost };
}

export function createRouter(defaultPolicy: RoutingPolicy) {
  return function route(ctx: RoutingContext, policy: RoutingPolicy = defaultPolicy): RouteDecision {
    if (policy.emergency_only && ctx.intent.priority !== 'EMERGENCY' && ctx.intent.type !== 'EMERGENCY_ALERT') {
      return {
        status: 'NO_ROUTE',
        reason: 'Emergency-only policy: non-emergency bundle suppressed',
      };
    }

    const candidates = planHopsForPeer(ctx, policy);
    if (candidates.length === 0) {
      return {
        status: 'NO_ROUTE',
        reason: 'No peer satisfies intent constraints under current policy',
      };
    }

    let best: { hops: RouteHop[]; rank: number; eval: ReturnType<typeof evaluatePlan> } | null = null;
    for (const hops of candidates) {
      const ev = evaluatePlan(hops);
      const rank = rankRoute({ ...ev, hops }, ctx.intent, policy);
      if (rank === null) continue;
      if (!best || rank > best.rank) {
        best = { hops, rank, eval: ev };
      }
    }

    if (!best) {
      return {
        status: 'NO_ROUTE',
        reason: 'All candidate plans violated hard constraints',
      };
    }

    const plan: RoutePlan = {
      bundle_id: '', // filled by caller; the router doesn't mint ids
      hops: best.hops,
      rationale: `Chose plan of ${best.hops.length} hop(s); reliability=${best.eval.est_reliability.toFixed(2)} latency=${best.eval.est_latency_ms}ms cost=${best.eval.est_cost}`,
      est_reliability: best.eval.est_reliability,
      est_latency_ms: best.eval.est_latency_ms,
      est_cost: best.eval.est_cost,
      created_at: Date.now(),
    };

    return { status: 'ROUTE_FOUND', plan, reason: plan.rationale };
  };
}

export { isTransportAllowed, isGatewayAllowed };

export type { TransportCapabilityType, GatewayCapabilityType, Intent };
