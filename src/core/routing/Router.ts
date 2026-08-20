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

  // 4. P5: Multi-hop route via gossiped capability cache (BFS over known_network).
  //    Runs BEFORE the opportunistic fallback so the latter's "no candidates"
  //    check correctly accounts for multi-hop plans.
  if (ctx.known_network && ctx.known_network.size > 0) {
    const multiHopPlans = planMultiHopViaKnownNetwork(ctx, policy);
    candidatePlans.push(...multiHopPlans);
  }

  // 5. Direct hop to a peer — opportunistic delivery.
  //    a) No specific destination: send to any reachable peer.
  //    b) destChannel set but no multi-hop plan was found (cold start, gossip
  //       not yet propagated, or no peer advertises the matching gateway
  //       capability): fall back to sending to the first reachable peer; the
  //       relay will re-route on receipt per P3.5 multi-hop forwarding OR
  //       epidemic replication (ARCH-027).
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

/**
 * P5: Multi-hop route planning via BFS over the gossiped known_network.
 *
 * For destNodeId: find a path from any immediate peer to the destNodeId,
 * where each intermediate node has FORWARD relay capability and a transport
 * to the next hop.
 *
 * For destChannel: find a path to any node that advertises the matching
 * GATEWAY capability.
 *
 * Returns a list of candidate plans. Each plan is an array of hops where
 * the first hop is a TRANSPORT to an immediate peer, and subsequent hops
 * are RELAY hops (the relay will forward on receipt per P3.5).
 *
 * We DO NOT verify that intermediate peers can actually reach each other
 * (no transport link verification). The gossiped capabilities tell us a
 * node has a transport type, not which specific peers it can reach. The
 * intermediate relay's tryForward will handle that at runtime.
 *
 * Reliability degrades geometrically per hop: 0.85^hop_count.
 */
function planMultiHopViaKnownNetwork(
  ctx: RoutingContext,
  policy: RoutingPolicy,
): RouteHop[][] {
  const plans: RouteHop[][] = [];
  const destNodeId = ctx.destination?.node_id;
  const destChannel = ctx.destination?.channel as GatewayCapabilityType | undefined;
  if (!destNodeId && !destChannel) return plans;
  if (!ctx.known_network) return plans;

  // Build adjacency: node_id -> set of node_ids it can reach (via its gossiped transports).
  // For simplicity, we assume any node with a transport can reach any other node
  // with a transport (we don't have link-level topology from gossip, only
  // capability advertisements). This is a conservative approximation; the
  // first hop still MUST be an immediate peer (verified via ctx.known_peers).
  const allNodes = Array.from(ctx.known_network.values());

  // Target: the destNodeId, OR any node with the matching GATEWAY capability.
  const isTarget = (nodeId: string): boolean => {
    if (destNodeId) return nodeId === destNodeId;
    return false;
  };
  const isGatewayTarget = (node: PeerCapabilities): boolean => {
    if (!destChannel) return false;
    return node.gateway.includes(destChannel) && isGatewayAllowed(policy, destChannel);
  };

  // BFS from each immediate peer.
  for (const startPeer of ctx.known_peers) {
    // BFS up to max_hops deep.
    const maxHops = policy.max_hops;
    const queue: Array<{ path: string[]; hopCount: number }> = [
      { path: [startPeer.node_id], hopCount: 1 },
    ];
    const visited = new Set<string>([startPeer.node_id]);

    while (queue.length > 0) {
      const { path, hopCount } = queue.shift()!;
      if (hopCount >= maxHops) continue;
      const lastNodeId = path[path.length - 1];
      const lastNode = ctx.known_network!.get(lastNodeId);
      if (!lastNode) continue;

      // Check if any node reachable from `lastNode` is a target.
      // We approximate "reachable" as "any node in the known_network that
      // isn't already in the path AND has a FORWARD relay capability."
      for (const candidate of allNodes) {
        if (visited.has(candidate.node_id)) continue;
        if (path.includes(candidate.node_id)) continue;
        // The candidate must have FORWARD relay capability to be a viable next hop.
        // (Or it's the target itself, in which case it just needs to exist.)
        const isTargetNode = isTarget(candidate.node_id) || isGatewayTarget(candidate);
        if (!isTargetNode && !candidate.relay.includes('FORWARD')) continue;
        // Check transport: candidate must have a transport that's policy-allowed.
        const hasAllowedTransport = candidate.transport.some((t) => isTransportAllowed(policy, t));
        if (!hasAllowedTransport) continue;

        const newPath = [...path, candidate.node_id];
        if (isTargetNode) {
          // Found a target! Build a plan.
          const hops: RouteHop[] = [];
          // First hop: TRANSPORT from this node to startPeer.
          const firstTransport = startPeer.transport.find((t) => isTransportAllowed(policy, t));
          if (!firstTransport) continue;
          hops.push({
            kind: 'TRANSPORT',
            to_node_id: startPeer.node_id,
            transport: firstTransport,
            est_reliability: 0.85,
            est_latency_ms: 100,
            est_cost: 1,
          });
          // Middle hops: RELAY through intermediate nodes.
          for (let i = 1; i < newPath.length - 1; i++) {
            const intermediateId = newPath[i];
            const intermediate = ctx.known_network!.get(intermediateId);
            if (!intermediate) break;
            const intermediateTransport = intermediate.transport.find((t) => isTransportAllowed(policy, t));
            hops.push({
              kind: 'RELAY',
              to_node_id: intermediateId,
              transport: intermediateTransport,
              est_reliability: 0.7,
              est_latency_ms: 200,
              est_cost: 2,
            });
          }
          // Last hop: the target.
          const lastTarget = candidate;
          if (isGatewayTarget(lastTarget)) {
            hops.push({
              kind: 'GATEWAY',
              to_node_id: lastTarget.node_id,
              gateway: destChannel,
              est_reliability: 0.85,
              est_latency_ms: 500,
              est_cost: 5,
            });
          } else {
            // Direct identity recipient — final TRANSPORT hop.
            const lastTransport = lastTarget.transport.find((t) => isTransportAllowed(policy, t));
            hops.push({
              kind: 'TRANSPORT',
              to_node_id: lastTarget.node_id,
              transport: lastTransport,
              est_reliability: 0.9,
              est_latency_ms: 100,
              est_cost: 1,
            });
          }
          plans.push(hops);
          // Don't continue BFS past this target — we found a path.
          continue;
        }

        // Not a target — keep BFS going.
        visited.add(candidate.node_id);
        queue.push({ path: newPath, hopCount: hopCount + 1 });
      }
    }
  }

  return plans;
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
