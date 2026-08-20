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
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { UniversalIdentity, UniversalIdentityRef } from '@/core/identity/types';
import type { NodeCapabilities } from '@/core/capabilities/types';
import type { Transport } from '@/core/transport/Transport';
import type { TransportEventSink } from '@/core/transport/TransportEvent';
import type { DeliveryTracker } from '@/core/delivery/DeliveryTracker';
import type { RoutingPolicy } from '@/core/policy/types';
import type { RoutePlan } from '@/core/routing/types';
import { createRouter } from '@/core/routing/Router';
import { createDeliveryTracker } from '@/core/delivery/DeliveryTracker';
import { defaultPolicy } from '@/core/policy/RoutingPolicy';
import { isExpired } from '@/core/bundle/CommunicationBundle';
import { ProtocolError } from '@/core/errors';

export interface NodeRuntimeDeps {
  identity: UniversalIdentity;
  capabilities: NodeCapabilities;
  transports: Transport[];
  routing_policy?: RoutingPolicy;
  /** Optional: local store-and-forward queue. */
  bundleStore?: BundleStore;
  /** Optional: gateway-facing adapter registry. */
  gatewayRegistry?: Map<string, { node_id: string; channel: string }>;
}

/**
 * Minimal in-process bundle store interface for store-and-forward semantics.
 */
export interface BundleStore {
  push(bundle: CommunicationBundle, nextHop: string, ts?: number): void;
  pop(): { bundle: CommunicationBundle; nextHop: string; queued_at: number } | undefined;
  size(): number;
  /** Iterate without removing. */
  peek(): Array<{ bundle: CommunicationBundle; nextHop: string; queued_at: number }>;
  remove(bundle_id: string): boolean;
  has(bundle_id: string): boolean;
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
  queuedBundles(): Array<{ bundle: CommunicationBundle; nextHop: string; queued_at: number }>;

  /** Get all peers we can see, by aggregating transports. */
  listReachablePeers(): Promise<string[]>;
}

export interface DispatchInput {
  bundle: CommunicationBundle;
  destination?: {
    node_id?: string;
    channel?: string;
    channel_id?: string;
    identity_id?: string;
  };
}

export interface DispatchResult {
  status: 'DISPATCHED' | 'QUEUED' | 'NO_ROUTE' | 'BUNDLE_EXPIRED' | 'ERROR';
  plan?: RoutePlan;
  error?: string;
}

export function createNodeRuntime(deps: NodeRuntimeDeps): NodeRuntime {
  const tracker = createDeliveryTracker();
  const policy = deps.routing_policy ?? defaultPolicy;
  const route = createRouter(policy);

  // For now, we don't have a structured PeerCapabilities cache; the runtime
  // exposes them per the transports that are attached. For P2 loopback, each
  // transport's peer set is the set of reachable peers.
  const knownPeerCache = new Map<string, { transport: TransportCapabilityTypeStr; node_id: string }>();

  const events: TransportEventSink = {
    emit() {
      /* no-op default; replaced below */
    },
    subscribe() {
      return () => {};
    },
  };

  for (const t of deps.transports) {
    t.onReceive((bundle, from) => {
      void receiveBundle(bundle, from);
    });
  }

  async function receiveBundle(bundle: CommunicationBundle, from_node_id: string): Promise<void> {
    // Dedup at the receiver too (THREAT_MODEL: replay + duplication).
    if (deps.bundleStore?.has(bundle.bundle_id)) return;
    if (isExpired(bundle)) {
      tracker.transition(bundle.bundle_id, 'EXPIRED', { node: deps.capabilities.node_id, note: 'arrived expired' });
      return;
    }

    // If this node is the destination identity, mark DELIVERED.
    const isRecipient =
      (bundle.recipient.kind === 'IDENTITY' && bundle.recipient.ref.id === deps.identity.id) ||
      (bundle.recipient.kind === 'CONVERSATION' && bundle.recipient.conversation_id.startsWith('conv:')) ||
      bundle.recipient.kind === 'CHANNEL';

    if (!tracker.get(bundle.bundle_id)) {
      tracker.init(bundle.bundle_id);
    }
    try {
      tracker.transition(bundle.bundle_id, 'ACCEPTED', { node: deps.capabilities.node_id, transport: 'loopback' });
      tracker.transition(bundle.bundle_id, 'RELAYED', { node: from_node_id, note: `received from ${from_node_id}` });
      if (isRecipient) {
        tracker.transition(bundle.bundle_id, 'DELIVERED', { node: deps.capabilities.node_id });
        // Recipient can mark READ later via explicit API.
      } else if (deps.bundleStore) {
        // We're a relay; queue for forwarding per DTN semantics.
        deps.bundleStore.push(bundle, 'next-hop');
      }
    } catch (err) {
      // Illegal transition means state machine violation; log it.
      void err;
    }
  }

  async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    if (isExpired(input.bundle)) {
      return { status: 'BUNDLE_EXPIRED' };
    }
    tracker.init(input.bundle.bundle_id);

    // Build a RoutingContext from known peers.
    const peers = await listReachablePeers();
    const peerCaps = peers.map((node_id) => ({
      node_id,
      transport: deps.transports
        .filter((t) => t.isAvailable())
        .map((t) => t.transport_type),
      relay: deps.capabilities.relay.size > 0 ? (['STORE', 'FORWARD'] as Array<'STORE' | 'FORWARD'>) : ([] as Array<'STORE' | 'FORWARD'>),
      gateway: Array.from(deps.capabilities.gateway),
      verification: 'UNVERIFIED' as const,
    }));

    const decision = route(
      {
        intent: input.bundle.intent,
        sender_node_id: deps.capabilities.node_id,
        known_peers: peerCaps,
        destination: input.destination,
      },
      policy,
    );

    if (decision.status !== 'ROUTE_FOUND' || !decision.plan) {
      tracker.transition(input.bundle.bundle_id, 'NO_ROUTE', { note: decision.reason });
      return { status: 'NO_ROUTE', error: decision.reason };
    }

    // Mutate plan to carry bundle_id (router returns blank id).
    const plan: RoutePlan = { ...decision.plan, bundle_id: input.bundle.bundle_id };

    tracker.transition(input.bundle.bundle_id, 'ACCEPTED', { node: deps.capabilities.node_id });

    // Execute the first hop only. Multi-hop is the DTN store's job at the next peer.
    const firstHop = plan.hops[0];
    if (!firstHop || !firstHop.to_node_id) {
      tracker.transition(input.bundle.bundle_id, 'NO_ROUTE', { note: 'plan missing first hop' });
      return { status: 'NO_ROUTE', error: 'plan missing first hop' };
    }

    const transport = deps.transports.find((t) => t.transport_type === firstHop.transport);
    if (!transport) {
      tracker.transition(input.bundle.bundle_id, 'TRANSPORT_UNAVAILABLE' as any, {
        note: `no transport for ${firstHop.transport}`,
      });
      // The state machine doesn't have TRANSPORT_UNAVAILABLE; use CHANNEL_UNAVAILABLE for now.
      return { status: 'ERROR', error: `no transport for ${firstHop.transport}` };
    }

    tracker.transition(input.bundle.bundle_id, 'QUEUED', { transport: transport.transport_id });
    const result = await transport.send(input.bundle, firstHop.to_node_id);
    if (result.kind === 'OK') {
      tracker.transition(input.bundle.bundle_id, 'RELAYED', {
        transport: transport.transport_id,
        node: firstHop.to_node_id,
      });
      return { status: 'DISPATCHED', plan };
    }

    // If first-hop send failed, attempt to queue for later (DTN semantics).
    if (deps.bundleStore) {
      deps.bundleStore.push(input.bundle, firstHop.to_node_id);
      return { status: 'QUEUED', plan };
    }
    return { status: 'ERROR', error: result.reason ?? 'send failed' };
  }

  async function listReachablePeers(): Promise<string[]> {
    // For P2 loopback: ask the bus via each transport. We approximate by
    // reading the transport's peer set if it exposes one.
    const peers = new Set<string>();
    for (const t of deps.transports) {
      if (!t.isAvailable()) continue;
      // LoopbackTransport exposes `peers` via cast; for the protocol-level
      // abstraction, we'd extend the Transport interface with peer discovery.
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
    events,
    dispatch,
    receiveBundle,
    queuedBundles() {
      return deps.bundleStore?.peek() ?? [];
    },
    listReachablePeers,
  };
}

// Local type alias to avoid importing types twice.
type TransportCapabilityTypeStr =
  | 'INTERNET'
  | 'WIFI'
  | 'BLE'
  | 'BLUETOOTH'
  | 'LAN'
  | 'WIFI_AWARE';

// Re-export public helpers (re-exporting imports for the API surface)
// (createInMemoryBundleStore is already `export function` above — no duplicate export here.)
export type { UniversalIdentity, UniversalIdentityRef };
