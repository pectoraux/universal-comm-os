/**
 * server/NodeRuntime.ts
 *
 * A node runtime that composes the canonical protocol primitives into a usable
 * Communication OS API surface for the Web client (and future Electron/Android/iOS).
 *
 * This runtime lives in the SERVER layer (Architecture Constitution Article I.7).
 * It MAY depend on core/*, transport/*, adapters/*, gateway/*.
 *
 * It is NOT the protocol — it is a participant in the protocol.
 *
 * ROADMAP P3 additions:
 *   - Multi-hop forwarding: a relay that receives a bundle NOT addressed to it
 *     runs its own router and forwards to the next hop (P3.5).
 *   - Replication fan-out: dispatch() may send the bundle to N independent
 *     relays in parallel; first OK wins; others are no-ops (P3.4).
 *   - RELAY_FORWARD proof: when a relay forwards a bundle, it signs a
 *     RELAY_FORWARD proof and appends it to the bundle's proofs[] (P3.6).
 *   - Deduplication is the responsibility of the BundleStore (P3.3); the
 *     runtime additionally consults the store's `has()` method.
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { UniversalIdentity, UniversalIdentityRef } from '@/core/identity/types';
import type { NodeCapabilities } from '@/core/capabilities/types';
import type { Transport } from '@/core/transport/Transport';
import type { TransportEventSink } from '@/core/transport/TransportEvent';
import type { DeliveryTracker } from '@/core/delivery/DeliveryTracker';
import type { RoutingPolicy } from '@/core/policy/types';
import type { RoutePlan, RouteHop, PeerCapabilities } from '@/core/routing/types';
import type { Proof } from '@/core/bundle/types';
import type { GatewayRuntime } from '@/gateway/GatewayRuntime';
import type { CapabilityCache, CapabilityAdvertisement } from '@/core/capabilities/CapabilityCache';
import { createRouter } from '@/core/routing/Router';
import { createDeliveryTracker } from '@/core/delivery/DeliveryTracker';
import { defaultPolicy } from '@/core/policy/RoutingPolicy';
import { isExpired, appendProof, canonicalEnvelope } from '@/core/bundle/CommunicationBundle';
import { signProof } from '@/core/trust/Proof';
import { hashBytes } from '@/core/trust/CryptoEnvelope';
import { toRef } from '@/core/identity/UniversalIdentity';
import { buildAdvertisement, rebroadcast } from '@/core/capabilities/CapabilityCache';

export interface NodeRuntimeDeps {
  identity: UniversalIdentity;
  capabilities: NodeCapabilities;
  transports: Transport[];
  routing_policy?: RoutingPolicy;
  /** Optional: local store-and-forward queue (in-memory OR Prisma-backed). */
  bundleStore?: BundleStore;
  /** Optional: the node's signing secret key (needed to sign RELAY_FORWARD proofs). */
  signing_secret_key?: Uint8Array;
  /**
   * Optional: the gateway runtime. When present AND this node advertises the
   * matching GATEWAY capability, CHANNEL-recipient bundles are delegated here
   * (P6). When absent, CHANNEL-recipient bundles fall through to DTN forwarding.
   */
  gatewayRuntime?: GatewayRuntime;
  /**
   * Optional (P5): capability cache for gossiped peer capabilities. When present,
   * the router uses the deep cache to plan multi-hop routes proactively. When
   * absent, the router falls back to single-hop + epidemic routing.
   */
  capabilityCache?: CapabilityCache;
  /** Optional: gateway-facing adapter registry (legacy, replaced by gatewayRuntime). */
  gatewayRegistry?: Map<string, { node_id: string; channel: string }>;
}

/**
 * BundleStore interface — both in-memory (tests) and Prisma (production)
 * implementations conform. May be sync or async.
 */
export interface BundleStore {
  push(bundle: CommunicationBundle, nextHop: string, ts?: number): void | Promise<void>;
  pop(): { bundle: CommunicationBundle; nextHop: string; queued_at: number } | undefined | Promise<{ bundle: CommunicationBundle; nextHop: string; queued_at: number } | undefined>;
  size(): number | Promise<number>;
  /** Iterate without removing. */
  peek(): Array<{ bundle: CommunicationBundle; nextHop: string; queued_at: number }> | Promise<Array<{ bundle: CommunicationBundle; nextHop: string; queued_at: number }>>;
  remove(bundle_id: string): boolean | Promise<boolean>;
  has(bundle_id: string): boolean | Promise<boolean>;
}

export function createInMemoryBundleStore(): BundleStore {
  const queue: Array<{ bundle: CommunicationBundle; nextHop: string; queued_at: number }> = [];
  const seen = new Set<string>();
  return {
    push(bundle, nextHop, ts = Date.now()) {
      if (seen.has(bundle.bundle_id)) return; // dedup (ARCH-003 + Protocol §10)
      seen.add(bundle.bundle_id);
      queue.push({ bundle, nextHop, queued_at: ts });
    },
    pop() {
      return queue.shift();
    },
    size() {
      return queue.length;
    },
    peek() {
      return [...queue];
    },
    remove(bundle_id) {
      const idx = queue.findIndex((x) => x.bundle.bundle_id === bundle_id);
      if (idx === -1) return false;
      queue.splice(idx, 1);
      return true;
    },
    has(bundle_id) {
      return seen.has(bundle_id);
    },
  };
}

export interface NodeRuntime {
  readonly node_id: string;
  readonly identity: UniversalIdentity;
  readonly capabilities: NodeCapabilities;
  readonly delivery: DeliveryTracker;
  readonly events: TransportEventSink;

  /** Compose + route + dispatch a brand new bundle from this node. */
  dispatch(input: DispatchInput): Promise<DispatchResult>;

  /** Called when a bundle is received from a transport. */
  receiveBundle(bundle: CommunicationBundle, from_node_id: string): Promise<void>;

  /** Snapshot of queued bundles. */
  queuedBundles(): Promise<Array<{ bundle: CommunicationBundle; nextHop: string; queued_at: number }>>;

  /** Get all peers we can see, by aggregating transports. */
  listReachablePeers(): Promise<string[]>;

  /** P5: push this node's capability advertisement to all peers (gossip). */
  gossipCapabilities(): void;

  /** P5: snapshot of this node's capability cache (gossiped view). */
  capabilityCacheSnapshot(): CapabilityAdvertisement[];
}

export interface DispatchInput {
  bundle: CommunicationBundle;
  destination?: {
    node_id?: string;
    channel?: string;
    channel_id?: string;
    identity_id?: string;
  };
  /** If true, send to N independent relays per replication_factor (P3.4). */
  replicate?: boolean;
}

export interface DispatchResult {
  status: 'DISPATCHED' | 'QUEUED' | 'NO_ROUTE' | 'BUNDLE_EXPIRED' | 'ERROR';
  plan?: RoutePlan;
  /** Number of relays the bundle was replicated to (P3.4). 1 = no replication. */
  replicas_sent?: number;
  error?: string;
}

export function createNodeRuntime(deps: NodeRuntimeDeps): NodeRuntime {
  const tracker = createDeliveryTracker();
  const policy = deps.routing_policy ?? defaultPolicy;
  const route = createRouter(policy);

  for (const t of deps.transports) {
    t.onReceive((bundle, from) => {
      void receiveBundle(bundle, from);
    });
    // P5: register gossip handler (duck-typed — only LoopbackTransport implements this).
    const anyT = t as unknown as {
      onGossip?: (handler: (ad: CapabilityAdvertisement, from_node_id: string) => void) => void;
    };
    if (anyT.onGossip && deps.capabilityCache) {
      anyT.onGossip((ad, from_node_id) => {
        if (!deps.capabilityCache) return;
        // Cache the advertisement.
        const updated = deps.capabilityCache.upsert(ad);
        // Rebroadcast to other peers (gossip propagation), bounded by hop_count.
        if (updated) {
          const rebroadcastAd = rebroadcast(ad, deps.capabilities.node_id);
          if (rebroadcastAd) {
            for (const tt of deps.transports) {
              const anyTT = tt as unknown as { gossip?: (a: CapabilityAdvertisement) => boolean };
              if (anyTT.gossip) anyTT.gossip(rebroadcastAd);
            }
          }
        }
      });
    }
  }

  /**
   * P5: push this node's capability advertisement to all peers.
   * Called periodically (every 5s in the demo) and once at startup.
   */
  function gossipCapabilities(): void {
    const ad = buildAdvertisement(deps.capabilities);
    if (deps.capabilityCache) {
      // Seed own cache.
      deps.capabilityCache.upsert(ad);
    }
    for (const t of deps.transports) {
      const anyT = t as unknown as { gossip?: (a: CapabilityAdvertisement) => boolean };
      if (anyT.gossip) anyT.gossip(ad);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // receiveBundle: entry point when a bundle arrives at this node via a
  // transport. The bundle's payload is opaque to us (we cannot decrypt it).
  // We must decide: am I the recipient? If yes -> DELIVERED. If no -> forward.
  // ──────────────────────────────────────────────────────────────────────
  async function receiveBundle(bundle: CommunicationBundle, from_node_id: string): Promise<void> {
    // Dedup at the receiver (THREAT_MODEL: replay + duplication).
    if (await deps.bundleStore?.has(bundle.bundle_id)) return;
    if (isExpired(bundle)) {
      if (!tracker.get(bundle.bundle_id)) tracker.init(bundle.bundle_id);
      try {
        tracker.transition(bundle.bundle_id, 'EXPIRED', {
          node: deps.capabilities.node_id,
          note: 'arrived expired',
        });
      } catch {
        // If state machine rejects (e.g. already terminal), ignore.
      }
      return;
    }

    const isRecipient =
      bundle.recipient.kind === 'IDENTITY' && bundle.recipient.ref.id === deps.identity.id;

    // P6: CHANNEL-recipient handling. If this node has a gatewayRuntime AND
    // advertises the matching GATEWAY capability, the gateway handles it.
    // ARCH-028: a node is NOT a gateway merely because it has Internet; the
    // GATEWAY capability must be explicit and the adapter must be registered.
    const isChannelGateway =
      bundle.recipient.kind === 'CHANNEL' &&
      deps.gatewayRuntime !== undefined &&
      deps.capabilities.gateway.has(bundle.recipient.channel as any);

    if (!tracker.get(bundle.bundle_id)) tracker.init(bundle.bundle_id);

    try {
      tracker.transition(bundle.bundle_id, 'ACCEPTED', {
        node: deps.capabilities.node_id,
        transport: 'loopback',
        note: `received from ${from_node_id}`,
      });

      if (isRecipient) {
        // This node IS the destination identity.
        tracker.transition(bundle.bundle_id, 'RELAYED', { node: from_node_id });
        tracker.transition(bundle.bundle_id, 'DELIVERED', { node: deps.capabilities.node_id });
        return;
      }

      if (isChannelGateway) {
        // P6: delegate to the gateway runtime.
        // State machine flow: ACCEPTED → RELAYED → GATEWAY_REACHED →
        // EXTERNAL_ACCEPTED → DELIVERED.
        // (RELAYED here = "bundle was relayed to me by an upstream peer".)
        tracker.transition(bundle.bundle_id, 'RELAYED', {
          node: from_node_id,
          note: 'gateway received via relay',
        });
        tracker.transition(bundle.bundle_id, 'GATEWAY_REACHED', {
          node: deps.capabilities.node_id,
          note: `gateway for channel ${bundle.recipient.channel}`,
        });
        const result = await deps.gatewayRuntime!.handleBundle({
          bundle,
          recipient_channel: bundle.recipient.channel as any,
          recipient_channel_id: bundle.recipient.channel_id,
        });
        if (result.status === 'OK') {
          tracker.transition(bundle.bundle_id, 'EXTERNAL_ACCEPTED', {
            node: deps.capabilities.node_id,
            transport: bundle.recipient.channel,
            note: `external_message_id: ${result.external_message_id ?? 'n/a'}`,
          });
          // For demo purposes, we also mark DELIVERED when the external channel
          // accepts (the actual "read" by the recipient happens out-of-band
          // via the channel's native retrieval, e.g., checking email).
          tracker.transition(bundle.bundle_id, 'DELIVERED', {
            node: deps.capabilities.node_id,
            note: 'external channel accepted; recipient reads via channel',
          });
        } else {
          tracker.transition(bundle.bundle_id, 'GATEWAY_UNAVAILABLE', {
            node: deps.capabilities.node_id,
            note: `gateway failed: ${result.status} — ${result.reason ?? ''}`,
          });
        }
        return;
      }

      // This node is a RELAY. Per DTN semantics, either forward immediately
      // or store for later. We try to forward immediately if we have a route.
      tracker.transition(bundle.bundle_id, 'RELAYED', {
        node: from_node_id,
        note: 'relay received',
      });

      const forwarded = await tryForward(bundle, from_node_id);
      if (!forwarded && deps.bundleStore) {
        // No immediate route; store-and-forward per DTN semantics.
        await deps.bundleStore.push(bundle, 'pending-route');
      }
    } catch (err) {
      // Illegal transition means state machine violation; log it silently
      // (in a real system we'd emit to observability).
      void err;
    }
  }

  /**
   * tryForward: the relay runs its own router to find a next hop and forwards
   * the bundle. Signs a RELAY_FORWARD proof and appends it (P3.6).
   *
   * P6 addition: when the router cannot find a specific route (typically
   * because the bundle's recipient is a CHANNEL and we lack gossiped peer
   * capabilities — P5 territory), the relay REPLICATES the bundle to ALL
   * non-sender peers simultaneously. Bundle_id dedup at each peer ensures
   * only one copy is processed; the gateway handles it, others silently drop.
   * This is a legitimate DTN "epidemic routing" fallback for partitioned
   * operation. With P5 capability gossip, the router will pick a specific peer.
   *
   * Returns true if the bundle was forwarded to at least one peer.
   */
  async function tryForward(
    bundle: CommunicationBundle,
    from_node_id: string,
  ): Promise<boolean> {
    const peers = await listReachablePeers();
    const candidatePeerIds = peers.filter((n) => n !== from_node_id);
    if (candidatePeerIds.length === 0) return false;

    const peerCaps = buildPeerCaps(candidatePeerIds, deps.capabilityCache, deps.transports, deps.capabilities);

    const decision = route(
      {
        intent: bundle.intent,
        sender_node_id: deps.capabilities.node_id,
        known_peers: peerCaps,
        destination: bundle.recipient.kind === 'IDENTITY' ? { identity_id: bundle.recipient.ref.id } : undefined,
        // P5: deep network cache for proactive multi-hop planning.
        known_network: buildKnownNetwork(deps.capabilityCache, peerCaps),
      },
      policy,
    );

    // P5: if the router found a multi-hop plan, prefer it over the epidemic fallback.
    // The router's BFS will produce a specific first hop (an immediate peer
    // that has a path to the target). If no multi-hop plan was found, fall back
    // to epidemic replication (ARCH-027, retired when gossip is healthy).

    // Targets to replicate to. Default: the router's plan first hop.
    // Fallback (P6, refined in P5): if the router picked a peer but the bundle's
    // recipient is a CHANNEL AND the router did NOT find a multi-hop plan to a
    // gateway (i.e., the plan has no GATEWAY hop), replicate to ALL non-sender
    // peers (epidemic routing). When P5 capability gossip is healthy, the
    // router WILL find a GATEWAY hop and the fallback doesn't fire.
    let targetNodeIds: string[] = [];
    let transportHint: RouteHop['transport'] | undefined;
    let hasGatewayHop = false;
    if (decision.status === 'ROUTE_FOUND' && decision.plan && decision.plan.hops.length > 0) {
      const firstHop = decision.plan.hops[0];
      transportHint = firstHop.transport;
      if (firstHop.to_node_id) targetNodeIds.push(firstHop.to_node_id);
      hasGatewayHop = decision.plan.hops.some((h) => h.kind === 'GATEWAY');
    }
    if (bundle.recipient.kind === 'CHANNEL' && targetNodeIds.length > 0 && !hasGatewayHop) {
      // CHANNEL recipient without a known gateway route: replicate to all
      // non-sender peers (epidemic). Bundle_id dedup ensures correctness.
      targetNodeIds = candidatePeerIds;
    }

    if (targetNodeIds.length === 0) return false;

    // Send to each target via the appropriate transport. Returns true if at
    // least one send succeeded.
    const sendResults = await Promise.all(
      targetNodeIds.map(async (toNodeId) => {
        const hop = { transport: transportHint, to_node_id: toNodeId };
        const transport = pickTransportForHop(deps.transports, hop);
        if (!transport || !transport.isAvailable()) {
          // Try any available transport that has this peer.
          const anyT = deps.transports.find((t) => {
            if (!t.isAvailable()) return false;
            const anyT = t as unknown as { peers?: Set<string> };
            return anyT.peers ? anyT.peers.has(toNodeId) : false;
          });
          if (!anyT) return false;
          return await sendWithProof(anyT, toNodeId);
        }
        return await sendWithProof(transport, toNodeId);
      }),
    );
    return sendResults.some((ok) => ok);

    async function sendWithProof(transport: Transport, to_node_id: string): Promise<boolean> {
      let bundleToForward = bundle;
      if (deps.signing_secret_key) {
        const relayProof = signProof(
          'RELAY_FORWARD',
          {
            bundle_id: bundle.bundle_id,
            relay_node_id: deps.capabilities.node_id,
            from_node_id,
            to_node_id,
            transport: transport.transport_type,
            ts: Date.now(),
          },
          toRef(deps.identity),
          deps.signing_secret_key,
        );
        bundleToForward = appendProof(bundle, relayProof);
      }
      const result = await transport.send(bundleToForward, to_node_id);
      return result.kind === 'OK';
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // dispatch: compose + route + send a brand new bundle from this node.
  // ──────────────────────────────────────────────────────────────────────
  async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    if (isExpired(input.bundle)) {
      return { status: 'BUNDLE_EXPIRED' };
    }
    tracker.init(input.bundle.bundle_id);

    const peers = await listReachablePeers();
    const peerCaps = buildPeerCaps(peers, deps.capabilityCache, deps.transports, deps.capabilities);

    const decision = route(
      {
        intent: input.bundle.intent,
        sender_node_id: deps.capabilities.node_id,
        known_peers: peerCaps,
        destination: input.destination,
        // P5: deep network cache for proactive multi-hop planning.
        known_network: buildKnownNetwork(deps.capabilityCache, peerCaps),
      },
      policy,
    );

    if (decision.status !== 'ROUTE_FOUND' || !decision.plan) {
      try { tracker.transition(input.bundle.bundle_id, 'NO_ROUTE', { note: decision.reason }); } catch {}
      return { status: 'NO_ROUTE', error: decision.reason };
    }

    const plan: RoutePlan = { ...decision.plan, bundle_id: input.bundle.bundle_id };

    try { tracker.transition(input.bundle.bundle_id, 'ACCEPTED', { node: deps.capabilities.node_id }); } catch {}

    // ── P3.4 Replication fan-out ──
    // If input.replicate === true AND policy.replication_factor > 1,
    // send to up to N independent relays in parallel. First OK wins; others
    // are silently discarded (their delivery still succeeds via the canonical
    // bundle_id deduplication at the recipient).
    const targetHops: RouteHop[] = input.replicate && policy.replication_factor > 1
      ? pickReplicas(decision.plan.hops, peers, policy.replication_factor)
      : decision.plan.hops;

    if (targetHops.length === 0 || !targetHops[0].to_node_id) {
      try { tracker.transition(input.bundle.bundle_id, 'NO_ROUTE', { note: 'plan missing first hop' }); } catch {}
      return { status: 'NO_ROUTE', error: 'plan missing first hop' };
    }

    try { tracker.transition(input.bundle.bundle_id, 'QUEUED', { transport: 'multi' }); } catch {}

    const sendResults = await Promise.all(
      targetHops.map(async (hop) => {
        const transport = pickTransportForHop(deps.transports, hop);
        if (!transport || !transport.isAvailable()) {
          return { ok: false, hop, reason: 'transport unavailable' };
        }
        const r = await transport.send(input.bundle, hop.to_node_id!);
        return { ok: r.kind === 'OK', hop, reason: r.kind === 'OK' ? undefined : r.reason };
      }),
    );

    const okResults = sendResults.filter((r) => r.ok);
    if (okResults.length > 0) {
      try {
        tracker.transition(input.bundle.bundle_id, 'RELAYED', {
          transport: 'multi',
          node: okResults[0].hop.to_node_id,
          note: `replicated to ${okResults.length}/${targetHops.length} peer(s)`,
        });
      } catch {}
      return { status: 'DISPATCHED', plan, replicas_sent: okResults.length };
    }

    // All sends failed -> queue for later (DTN semantics).
    if (deps.bundleStore) {
      await deps.bundleStore.push(input.bundle, targetHops[0].to_node_id!);
      return { status: 'QUEUED', plan, replicas_sent: 0 };
    }
    return { status: 'ERROR', error: sendResults[0]?.reason ?? 'send failed' };
  }

  async function listReachablePeers(): Promise<string[]> {
    const peers = new Set<string>();
    for (const t of deps.transports) {
      if (!t.isAvailable()) continue;
      const anyT = t as unknown as { peers?: Set<string> };
      if (anyT.peers) for (const p of anyT.peers) peers.add(p);
    }
    return Array.from(peers);
  }

  return {
    node_id: deps.capabilities.node_id,
    identity: deps.identity,
    capabilities: deps.capabilities,
    delivery: tracker,
    events: { emit() {}, subscribe() { return () => {}; } },
    dispatch,
    receiveBundle,
    async queuedBundles() {
      if (!deps.bundleStore) return [];
      const peek = await deps.bundleStore.peek();
      return peek;
    },
    listReachablePeers,
    gossipCapabilities,
    capabilityCacheSnapshot() {
      return deps.capabilityCache?.snapshot() ?? [];
    },
  };
}

/**
 * Pick N independent first-hops for replication. Currently uses the single
 * route plan's first hop + falls back to any other reachable peers that
 * support a transport. A more sophisticated version would consult a per-peer
 * reliability score (P9 territory).
 */
function pickReplicas(
  planHops: RouteHop[],
  allPeers: string[],
  replicationFactor: number,
): RouteHop[] {
  if (planHops.length === 0) return [];
  const primary = planHops[0];
  if (allPeers.length <= 1 || replicationFactor <= 1) return [primary];
  const replicas: RouteHop[] = [primary];
  // Add additional peers as replicas, capped at replicationFactor.
  for (const peerId of allPeers) {
    if (replicas.length >= replicationFactor) break;
    if (peerId === primary.to_node_id) continue;
    replicas.push({
      ...primary,
      to_node_id: peerId,
      est_reliability: Math.max(0.3, (primary.est_reliability ?? 0.5) * 0.8),
    });
  }
  return replicas;
}

/**
 * Pick the transport that (a) matches the hop's transport type AND (b) actually
 * has the target peer in its peer set. A node may have multiple transports of
 * the same type on different buses; the wrong one would fail the send.
 *
 * This is a server-layer helper (Architecture Constitution Article I.7). It
 * casts to LoopbackTransport's peer Set — in P4 when Android transports are
 * added, the Transport interface should expose a `canReach(node_id)` method.
 */
function pickTransportForHop(
  transports: Transport[],
  hop: { transport?: RouteHop['transport']; to_node_id?: string },
): Transport | undefined {
  return transports.find((t) => {
    if (t.transport_type !== hop.transport) return false;
    if (!hop.to_node_id) return true;
    const anyT = t as unknown as { peers?: Set<string> };
    return anyT.peers ? anyT.peers.has(hop.to_node_id) : true;
  });
}

/**
 * P5: build the known_network map for the router from this node's
 * capability cache + immediate peers. The cache contains gossiped
 * CapabilityAdvertisement objects; we extract PeerCapabilities from each.
 *
 * The map includes:
 *   - All gossiped peer capabilities (the deep view).
 *   - All immediate peers' capabilities (from the routing context's
 *     known_peers, which may be more up-to-date than the cache for direct
 *     neighbors).
 *
 * If the capability cache is empty (cold start), returns undefined — the
 * router falls back to single-hop + opportunistic + epidemic routing.
 */
function buildKnownNetwork(
  cache: CapabilityCache | undefined,
  immediatePeers: PeerCapabilities[],
): Map<string, PeerCapabilities> | undefined {
  if (!cache) return undefined;
  const snapshot = cache.snapshot();
  if (snapshot.length === 0) return undefined;
  const map = new Map<string, PeerCapabilities>();
  for (const ad of snapshot) {
    const c = ad.capabilities;
    map.set(c.node_id, {
      node_id: c.node_id,
      transport: Array.from(c.transport) as any,
      relay: Array.from(c.relay) as any,
      gateway: Array.from(c.gateway) as any,
      resource: {
        bandwidth_bps: c.resource.bandwidth_bps,
        battery_pct: c.resource.battery_pct,
        storage_bytes: c.resource.storage_bytes,
        compute_units: c.resource.compute_units,
      },
      verification: c.verification,
    });
  }
  // Overlay with immediate peers (more up-to-date for direct neighbors).
  for (const peer of immediatePeers) {
    map.set(peer.node_id, peer);
  }
  return map;
}

/**
 * P9: build peerCaps for IMMEDIATE peers using the capability cache.
 *
 * Previously (P3-P8 bug): peerCaps used the LOCAL node's caps for ALL peers.
 * This was wrong — each peer has its own caps. P9 fixes this by looking up
 * each peer's actual caps in the capability cache.
 *
 * If the cache doesn't have an entry for a peer (cold start, gossip not yet
 * propagated), fall back to a minimal PeerCapabilities with the local node's
 * transport types as a best-effort guess.
 */
function buildPeerCaps(
  peerNodeIds: string[],
  cache: CapabilityCache | undefined,
  localTransports: Transport[],
  localCapabilities: NodeCapabilities,
): PeerCapabilities[] {
  return peerNodeIds.map((node_id) => {
    if (cache) {
      const ad = cache.get(node_id);
      if (ad) {
        const c = ad.capabilities;
        return {
          node_id,
          transport: Array.from(c.transport) as any,
          relay: Array.from(c.relay) as any,
          gateway: Array.from(c.gateway) as any,
          resource: {
            bandwidth_bps: c.resource.bandwidth_bps,
            battery_pct: c.resource.battery_pct,
            storage_bytes: c.resource.storage_bytes,
            compute_units: c.resource.compute_units,
          },
          verification: c.verification,
        };
      }
    }
    // Fallback: minimal caps (cold start).
    return {
      node_id,
      transport: localTransports.filter((t) => t.isAvailable()).map((t) => t.transport_type),
      relay: localCapabilities.relay.size > 0 ? (['STORE', 'FORWARD'] as Array<'STORE' | 'FORWARD'>) : ([] as Array<'STORE' | 'FORWARD'>),
      gateway: Array.from(localCapabilities.gateway),
      verification: localCapabilities.verification,
    };
  });
}

export type { UniversalIdentity, UniversalIdentityRef, Proof, CommunicationBundle };
