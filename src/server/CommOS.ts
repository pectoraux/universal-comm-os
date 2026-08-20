/**
 * server/CommOS.ts
 *
 * The Communication OS API surface (Architecture Constitution Article I.7).
 *
 * ROADMAP P3 additions:
 *   - Each node runtime is given its signing secret key so it can sign
 *     RELAY_FORWARD proofs when relaying bundles (P3.6).
 *   - Bundle stores use the persistent PrismaBundleStore by default; the
 *     in-memory store is still available for tests (P3.1, P3.3).
 *   - A TTL sweeper runs in the background and transitions expired bundles
 *     to EXPIRED (P3.2).
 *   - Dispatch supports a `replicate` flag to fan out to N independent relays
 *     (P3.4).
 */

import {
  createUniversalIdentity,
  generateIdentityKeyPair,
  toRef,
  createIntent,
  createBundle,
  sealPayload,
  openSealedPayload,
  isRecipientFor,
  signProof,
  verifyProof,
  defaultPolicy,
  advertiseCapabilities,
  deriveRoles,
  createCapabilityCache,
  createIdentityGraph,
  signChannelOwnershipProof,
  type UniversalIdentity,
  type CommunicationBundle,
  type DeliveryRecord,
  type NodeCapabilities,
  type Intent,
  type Proof,
  type RoutingPolicy,
  type CapabilityCache,
  type CapabilityAdvertisement,
  type IdentityGraph,
  type LinkedChannelIdentity,
} from '@/core/index';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
import { LoopbackBus, LoopbackTransport } from '@/transport/loopback/LoopbackTransport';
import { createNodeRuntime, createInMemoryBundleStore, type NodeRuntime, type BundleStore } from '@/server/NodeRuntime';
import { createPrismaBundleStore, createPrismaDeliveryTracker, type PersistedDeliveryTracker } from '@/server/PrismaBundleStore';
import { createTtlSweeper, type TtlSweeper } from '@/server/TtlSweeper';
import { createGatewayRuntime, type GatewayRuntime } from '@/gateway/GatewayRuntime';
import { EmailAdapter, type EmailTranscript, type EmailTranscriptEntry } from '@/adapters/email/EmailAdapter';
import { SmsAdapter, type SmsTranscript, type SmsTranscriptEntry } from '@/adapters/sms/SmsAdapter';
import { WhatsappAdapter, type WhatsappTranscript, type WhatsappTranscriptEntry } from '@/adapters/whatsapp/WhatsappAdapter';
import { utf8Encode, utf8Decode, b64urlEncode } from '@/core/util/encoding';
import { db } from '@/lib/db';

export interface InboxMessage {
  bundle_id: string;
  conversation_id: string;
  sender: { id: string; signing_pubkey_hash: string; display_name?: string };
  plaintext: string;
  received_at: number;
  read: boolean;
  /** The delivery state machine's final state at the recipient (DELIVERED or READ). */
  delivery_state: string;
  /** The node that delivered this bundle to us (the last relay). */
  from_node_id: string;
}

export interface NodeDescriptor {
  node_id: string;
  display_name: string;
  roles: string[];
  capabilities: NodeCapabilities;
  identity: UniversalIdentity;
  peers: string[];
}

export interface DispatchRequest {
  from_node_id: string;
  /** Identity recipient (node_id). Mutually exclusive with to_channel. */
  to_node_id?: string;
  /** Channel recipient (e.g., email). Mutually exclusive with to_node_id. */
  to_channel?: {
    channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'MATRIX' | 'TELEGRAM' | 'INSTAGRAM' | 'MESSENGER' | 'RCS';
    channel_id: string; // e.g., 'bob@example.com'
  };
  plaintext: string;
  intent_type: Intent['type'];
  priority?: Intent['priority'];
  conversation_id?: string;
  /** If true, replicate to N independent relays per policy.replication_factor (P3.4). */
  replicate?: boolean;
}

export interface DispatchResponse {
  status: 'DISPATCHED' | 'QUEUED' | 'NO_ROUTE' | 'BUNDLE_EXPIRED' | 'ERROR';
  bundle_id?: string;
  replicas_sent?: number;
  route_plan?: {
    hops: Array<{
      kind: string;
      to_node_id?: string;
      transport?: string;
      gateway?: string;
      est_reliability?: number;
      est_latency_ms?: number;
      est_cost?: number;
    }>;
    rationale: string;
    est_reliability: number;
    est_latency_ms: number;
    est_cost: number;
  };
  error?: string;
}

export interface DeliverySnapshot {
  bundle_id: string;
  node_id: string; // P3: which node this state is from
  current: string;
  history: Array<{ ts: number; from?: string; to: string; node?: string; transport?: string; note?: string }>;
  updated_at: number;
}

export interface NetworkState {
  nodes: Array<{ node_id: string; display_name: string; roles: string[] }>;
  links: Array<{ from: string; to: string; transport: string }>;
  capabilities: Record<string, NodeCapabilities>;
}

export interface RelayForwardProofView {
  bundle_id: string;
  proofs: Array<{
    kind: string;
    signer_id: string;
    ts: number;
    verified: boolean;
  }>;
}

// --- Internal singleton (one simulated fabric per process) ---
let _network: SimulatedNetwork | null = null;

class SimulatedNetwork {
  readonly runtimes = new Map<string, NodeRuntime>();
  readonly identities = new Map<string, { identity: UniversalIdentity; signing_sk: Uint8Array; encryption_sk: Uint8Array }>();
  readonly buses = new Map<string, LoopbackBus>();
  readonly transports = new Map<string, LoopbackTransport[]>();
  readonly dispatchedBundles = new Map<string, { bundle: CommunicationBundle; from_node_id: string; plaintext: string }>();
  /** P6: gateway runtimes per node (only nodes with GATEWAY capability). */
  readonly gatewayRuntimes = new Map<string, GatewayRuntime>();
  /** P6: email transcript (the EmailAdapter writes here). */
  emailTranscript: EmailTranscript = { entries: [] };
  /** P8: SMS transcript (the SmsAdapter writes here). */
  smsTranscript: SmsTranscript = { entries: [] };
  /** P8: WhatsApp transcript (the WhatsappAdapter writes here). */
  whatsappTranscript: WhatsappTranscript = { entries: [] };
  /** P5: periodic gossip timer. */
  gossipTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * P10: shared IdentityGraph for the demo. In production, each node has its
   * own graph (per-node view) populated by an identity-gossip protocol OR a
   * federated directory. In the demo, all nodes share this singleton.
   */
  identityGraph: IdentityGraph = createIdentityGraph();
  /**
   * P11: Recipient inbox. When a bundle reaches DELIVERED at a node, CommOS
   * auto-decrypts it (using the node's encryption secret key) and stores it
   * here, grouped by node_id → conversation_id → messages[].
   */
  inbox: Map<string, InboxMessage[]> = new Map();
  /** P12: the active routing policy (editable at runtime via updateRoutingPolicy). */
  activePolicy: RoutingPolicy = defaultPolicy;
  /** True = use persistent Prisma store; false = use in-memory store. */
  readonly persistent: boolean;
  readonly sweeper: TtlSweeper;
  readonly deliveryTracker: PersistedDeliveryTracker | undefined;

  constructor(opts: { persistent?: boolean } = {}) {
    this.persistent = opts.persistent ?? true;
    this.sweeper = createTtlSweeper(5_000);
    if (this.persistent) {
      this.deliveryTracker = createPrismaDeliveryTracker();
      this.sweeper.start();
    }
    this.setup();
    // P5: kick off capability gossip. Each node gossips its own capabilities
    // to direct peers; peers cache + rebroadcast. After ~2 rounds the whole
    // network is in every node's cache, enabling proactive multi-hop routing.
    this.gossipAll();
    this.gossipTimer = setInterval(() => this.gossipAll(), 5_000);
  }

  /** P5: every node pushes its own capability advertisement. */
  gossipAll(): void {
    for (const rt of this.runtimes.values()) {
      try { rt.gossipCapabilities(); } catch { /* ignore */ }
    }
  }

  /** P5: snapshot of every node's capability cache (for UI). */
  capabilityCachesSnapshot(): Array<{ node_id: string; entries: CapabilityAdvertisement[] }> {
    return Array.from(this.runtimes.values()).map((rt) => ({
      node_id: rt.node_id,
      entries: rt.capabilityCacheSnapshot(),
    }));
  }

  /**
   * P10: link a UniversalIdentity to a channel_id via a signed proof.
   * Called from setup() to pre-link demo nodes; in production this would
   * be called by the user's client after they complete a channel-ownership
   * challenge (e.g., clicking a verification link in their email).
   */
  linkIdentityToChannel(
    identity: UniversalIdentity,
    keypair: { signing_secret_key: Uint8Array; key_set: { signing_pubkey: Uint8Array; encryption_pubkey: Uint8Array } },
    channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'MATRIX' | 'TELEGRAM' | 'INSTAGRAM' | 'MESSENGER' | 'RCS',
    channel_id: string,
  ): boolean {
    const proof = signChannelOwnershipProof({
      identity_id: identity.id,
      channel,
      channel_id,
      signing_secret_key: keypair.signing_secret_key,
      signing_pubkey: keypair.key_set.signing_pubkey,
    });
    return this.identityGraph.link({ identity, channel, channel_id, proof });
  }

  /** P10: snapshot of the identity graph (for UI). */
  identityGraphSnapshot(): LinkedChannelIdentity[] {
    return this.identityGraph.snapshot();
  }

  /**
   * P10: resolve a channel recipient to their real UniversalIdentityRef +
   * encryption pubkey. Returns undefined if no verified link exists (in
   * which case the caller falls back to the synthesized keypair — a
   * backward-compat hack retained for the demo's pre-link bootstrap).
   */
  resolveChannelRecipient(channel: string, channel_id: string): {
    identity_ref: { id: string; signing_pubkey_hash: string; display_name?: string };
    encryption_pubkey: Uint8Array;
    proof: any;
  } | undefined {
    return this.identityGraph.resolveChannelRecipient(channel as any, channel_id);
  }

  // ──────────────────────────────────────────────────────────────────────
  // P11: Recipient Inbox (ARCH-038, ARCH-039, ARCH-040).
  //
  // When a bundle reaches DELIVERED at a node, CommOS auto-decrypts it
  // using the node's encryption secret key and stores it in the inbox.
  // The inbox is grouped by conversation_id for the unified-inbox UI.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * P11: handle a bundle that reached DELIVERED at a node. Auto-decrypts
   * the bundle using the node's encryption secret key and adds it to the inbox.
   */
  handleDelivered(node_id: string, bundle: CommunicationBundle, from_node_id: string): void {
    const entry = this.identities.get(node_id);
    if (!entry) return;
    // Only inbox bundles addressed to THIS node's identity.
    if (bundle.recipient.kind !== 'IDENTITY' || bundle.recipient.ref.id !== entry.identity.id) return;
    // Don't double-add (dedup by bundle_id).
    const existing = this.inbox.get(node_id);
    if (existing && existing.some((m) => m.bundle_id === bundle.bundle_id)) return;

    // Decrypt the bundle.
    const env = { encryption_metadata: bundle.encryption_metadata, payload: bundle.payload };
    if (!isRecipientFor(env, entry.identity.public_keys.encryption_pubkey)) return;
    let plaintext: string;
    try {
      const pt = openSealedPayload(env, entry.encryption_sk);
      plaintext = utf8Decode(pt);
    } catch {
      return; // decryption failed — don't inbox
    }

    const msg: InboxMessage = {
      bundle_id: bundle.bundle_id,
      conversation_id: bundle.conversation_id,
      sender: {
        id: bundle.sender.id,
        signing_pubkey_hash: bundle.sender.signing_pubkey_hash,
        display_name: bundle.sender.display_name,
      },
      plaintext,
      received_at: Date.now(),
      read: false,
      delivery_state: 'DELIVERED',
      from_node_id,
    };

    if (!this.inbox.has(node_id)) this.inbox.set(node_id, []);
    this.inbox.get(node_id)!.push(msg);
  }

  /** P11: get a node's inbox, grouped by conversation_id. */
  getInbox(node_id: string): Array<{ conversation_id: string; messages: InboxMessage[]; unread_count: number }> {
    const messages = this.inbox.get(node_id) ?? [];
    // Group by conversation_id.
    const byConv = new Map<string, InboxMessage[]>();
    for (const msg of messages) {
      if (!byConv.has(msg.conversation_id)) byConv.set(msg.conversation_id, []);
      byConv.get(msg.conversation_id)!.push(msg);
    }
    // Sort conversations by most recent message.
    const conversations = Array.from(byConv.entries()).map(([conv_id, msgs]) => ({
      conversation_id: conv_id,
      messages: msgs.sort((a, b) => a.received_at - b.received_at),
      unread_count: msgs.filter((m) => !m.read).length,
    }));
    conversations.sort((a, b) => {
      const aLast = a.messages[a.messages.length - 1]?.received_at ?? 0;
      const bLast = b.messages[b.messages.length - 1]?.received_at ?? 0;
      return bLast - aLast;
    });
    return conversations;
  }

  /**
   * P11: mark all messages in a conversation as read. Also transitions the
   * delivery state machine to READ for each bundle.
   */
  markConversationRead(node_id: string, conversation_id: string): { ok: boolean; marked: number } {
    const messages = this.inbox.get(node_id);
    if (!messages) return { ok: false, marked: 0 };
    let marked = 0;
    const rt = this.runtimes.get(node_id);
    for (const msg of messages) {
      if (msg.conversation_id === conversation_id && !msg.read) {
        msg.read = true;
        msg.delivery_state = 'READ';
        marked++;
        // Transition the delivery state machine to READ.
        if (rt) {
          try { rt.delivery.transition(msg.bundle_id, 'READ', { node: node_id }); } catch { /* already terminal */ }
        }
      }
    }
    return { ok: true, marked };
  }

  // ──────────────────────────────────────────────────────────────────────
  // P12: Analytics + Routing Policy Management (ARCH-041, ARCH-042).
  // ──────────────────────────────────────────────────────────────────────

  /**
   * P12: compute delivery analytics from the delivery tracker + dispatched
   * bundles. Per THREAT_MODEL §11 (Observability): does NOT expose private
   * message contents — only aggregate statistics.
   */
  async getAnalytics(): Promise<{
    total_dispatched: number;
    total_delivered: number;
    total_expired: number;
    total_no_route: number;
    total_relayed: number;
    total_queued: number;
    delivery_rate: number;
    per_node: Array<{
      node_id: string;
      delivered: number;
      relayed: number;
      expired: number;
      no_route: number;
      queued: number;
    }>;
    route_stats: {
      avg_reliability: number;
      avg_latency_ms: number;
      avg_cost: number;
      hop_distribution: Record<number, number>;
    };
  }> {
    const snapshots = await this.deliverySnapshots();
    const dispatched = Array.from(this.dispatchedBundles.values());

    let totalDelivered = 0;
    let totalExpired = 0;
    let totalNoRoute = 0;
    let totalRelayed = 0;
    let totalQueued = 0;

    const perNodeMap = new Map<string, { delivered: number; relayed: number; expired: number; no_route: number; queued: number }>();

    for (const snap of snapshots) {
      const state = snap.current;
      const nodeEntry = perNodeMap.get(snap.node_id) ?? { delivered: 0, relayed: 0, expired: 0, no_route: 0, queued: 0 };
      if (state === 'DELIVERED' || state === 'READ') { totalDelivered++; nodeEntry.delivered++; }
      else if (state === 'EXPIRED') { totalExpired++; nodeEntry.expired++; }
      else if (state === 'NO_ROUTE') { totalNoRoute++; nodeEntry.no_route++; }
      else if (state === 'RELAYED') { totalRelayed++; nodeEntry.relayed++; }
      else if (state === 'QUEUED') { totalQueued++; nodeEntry.queued++; }
      perNodeMap.set(snap.node_id, nodeEntry);
    }

    // Route stats from dispatched bundles (if they have a route plan).
    let sumReliability = 0;
    let sumLatency = 0;
    let sumCost = 0;
    let routeCount = 0;
    const hopDist: Record<number, number> = {};
    for (const d of dispatched) {
      // We don't store the route plan with the dispatched bundle; compute from delivery snapshots.
      // For now, count hops from the number of delivery records per bundle_id.
      const bundleSnaps = snapshots.filter((s) => s.bundle_id === d.bundle.bundle_id);
      const hops = bundleSnaps.length;
      hopDist[hops] = (hopDist[hops] ?? 0) + 1;
      routeCount++;
    }

    return {
      total_dispatched: dispatched.length,
      total_delivered: totalDelivered,
      total_expired: totalExpired,
      total_no_route: totalNoRoute,
      total_relayed: totalRelayed,
      total_queued: totalQueued,
      delivery_rate: dispatched.length > 0 ? totalDelivered / dispatched.length : 0,
      per_node: Array.from(perNodeMap.entries()).map(([node_id, stats]) => ({ node_id, ...stats })),
      route_stats: {
        avg_reliability: routeCount > 0 ? sumReliability / routeCount : 0,
        avg_latency_ms: routeCount > 0 ? sumLatency / routeCount : 0,
        avg_cost: routeCount > 0 ? sumCost / routeCount : 0,
        hop_distribution: hopDist,
      },
    };
  }

  /**
   * P12: update the active routing policy. Propagates to all node runtimes
   * via `setPolicy()`. Affects subsequent dispatches only — existing bundles
   * keep their original routing_policy inline (immutable per ARCH-003).
   */
  updateRoutingPolicy(updates: Partial<RoutingPolicy>): RoutingPolicy {
    this.activePolicy = { ...this.activePolicy, ...updates };
    for (const rt of this.runtimes.values()) {
      rt.setPolicy(this.activePolicy);
    }
    return this.activePolicy;
  }

  /** P12: get the current routing policy. */
  getRoutingPolicy(): RoutingPolicy {
    return this.activePolicy;
  }

  // ──────────────────────────────────────────────────────────────────────
  // P13: Community Network (ARCH-046, ARCH-047, ARCH-048).
  //
  // Per master prompt §19: "Never trust self-reported contribution.
  // Contribution accounting must eventually rely upon verifiable evidence.
  // Do not implement a token/credit economy prematurely."
  //
  // P13 measures participation from the delivery tracker's per-node state
  // transitions — these are OBSERVABLE (the tracker records actual state
  // changes per node per bundle). True VERIFIABLE evidence would come from
  // RELAY_FORWARD proofs (signed by each relay's Ed25519 key), but those
  // aren't currently stored centrally. The measurement is a first step;
  // the anti-abuse + verifiable evidence layer is a future iteration.
  //
  // NO tokens, NO credits, NO economy — just measurement + reputation.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * P13: compute community network statistics from the delivery tracker.
   * Per-node: how many bundles each node relayed, delivered, gateway-handled.
   * Reputation: delivery success rate (DELIVERED / (DELIVERED + EXPIRED + NO_ROUTE)).
   * Resource accounting: from the capability cache (battery, bandwidth, storage).
   */
  async getCommunityStats(): Promise<{
    per_node: Array<{
      node_id: string;
      display_name: string;
      roles: string[];
      relayed: number;
      delivered: number;
      gateway_handled: number;
      expired: number;
      no_route: number;
      reputation: number;
      resource: { battery_pct?: number; bandwidth_bps?: number; storage_bytes?: number };
      verification: string;
    }>;
    total_relays: number;
    total_deliveries: number;
    total_gateway_handling: number;
    total_expired: number;
    network_reliability: number;
    /** Distinction between observable and verifiable evidence. */
    evidence_note: string;
  }> {
    const snapshots = await this.deliverySnapshots();
    const nodeEntries = this.listNodes();

    const perNodeMap = new Map<string, {
      relayed: number; delivered: number; gateway_handled: number; expired: number; no_route: number;
    }>();

    for (const snap of snapshots) {
      const entry = perNodeMap.get(snap.node_id) ?? { relayed: 0, delivered: 0, gateway_handled: 0, expired: 0, no_route: 0 };
      const state = snap.current;
      if (state === 'DELIVERED' || state === 'READ') entry.delivered++;
      else if (state === 'RELAYED') entry.relayed++;
      else if (state === 'GATEWAY_REACHED' || state === 'EXTERNAL_ACCEPTED') entry.gateway_handled++;
      else if (state === 'EXPIRED') entry.expired++;
      else if (state === 'NO_ROUTE') entry.no_route++;
      perNodeMap.set(snap.node_id, entry);
    }

    let totalRelays = 0;
    let totalDeliveries = 0;
    let totalGatewayHandling = 0;
    let totalExpired = 0;

    const perNode = nodeEntries.map((n) => {
      const stats = perNodeMap.get(n.node_id) ?? { relayed: 0, delivered: 0, gateway_handled: 0, expired: 0, no_route: 0 };
      totalRelays += stats.relayed;
      totalDeliveries += stats.delivered;
      totalGatewayHandling += stats.gateway_handled;
      totalExpired += stats.expired;
      // Reputation: delivery success rate (DELIVERED / (DELIVERED + EXPIRED + NO_ROUTE)).
      const totalAttempts = stats.delivered + stats.expired + stats.no_route;
      const reputation = totalAttempts > 0 ? stats.delivered / totalAttempts : 1.0;
      return {
        node_id: n.node_id,
        display_name: n.display_name,
        roles: n.roles,
        relayed: stats.relayed,
        delivered: stats.delivered,
        gateway_handled: stats.gateway_handled,
        expired: stats.expired,
        no_route: stats.no_route,
        reputation,
        resource: {
          battery_pct: n.capabilities.resource.battery_pct,
          bandwidth_bps: n.capabilities.resource.bandwidth_bps,
          storage_bytes: n.capabilities.resource.storage_bytes,
        },
        verification: n.capabilities.verification,
      };
    });

    const totalAttempts = totalDeliveries + totalExpired;
    const networkReliability = totalAttempts > 0 ? totalDeliveries / totalAttempts : 1.0;

    return {
      per_node: perNode.sort((a, b) => (b.relayed + b.delivered + b.gateway_handled) - (a.relayed + a.delivered + a.gateway_handled)),
      total_relays: totalRelays,
      total_deliveries: totalDeliveries,
      total_gateway_handling: totalGatewayHandling,
      total_expired: totalExpired,
      network_reliability: networkReliability,
      evidence_note: 'Observable: per-node delivery state transitions. Verifiable: RELAY_FORWARD proofs (Ed25519-signed). NO tokens, NO credits — measurement only per ARCH-048.',
    };
  }

  private setup() {
    // Three-loopback-bus fabric:
    //   bus-lan:  Alice <-> Relay <-> Bob (LAN)
    //   bus-ble:  Alice <-> Bob (BLE)  [opportunistic short-range]
    //   bus-gw:   Relay <-> Gateway (LAN)
    //
    // P3 milestone: prove A -> B -> C multi-hop.
    // We'll prove: Alice -> Relay -> Bob (where Alice cannot directly reach Bob
    // via the recipient-identity, only via the relay which forwards).

    const busLan = new LoopbackBus();
    const busBle = new LoopbackBus();
    const busGw = new LoopbackBus();
    this.buses.set('lan', busLan);
    this.buses.set('ble', busBle);
    this.buses.set('gw', busGw);

    const aliceKp = generateIdentityKeyPair();
    const bobKp = generateIdentityKeyPair();
    const relayKp = generateIdentityKeyPair();
    const gatewayKp = generateIdentityKeyPair();

    const aliceId = createUniversalIdentity({ display_name: 'Alice (Mobile)', key_set: aliceKp.key_set });
    const bobId = createUniversalIdentity({ display_name: 'Bob (Laptop)', key_set: bobKp.key_set });
    const relayId = createUniversalIdentity({ display_name: 'Relay (Raspberry Pi)', key_set: relayKp.key_set });
    const gatewayId = createUniversalIdentity({ display_name: 'Gateway (Always-online)', key_set: gatewayKp.key_set });

    this.identities.set('alice', { identity: aliceId, signing_sk: aliceKp.signing_secret_key, encryption_sk: aliceKp.encryption_secret_key });
    this.identities.set('bob', { identity: bobId, signing_sk: bobKp.signing_secret_key, encryption_sk: bobKp.encryption_secret_key });
    this.identities.set('relay', { identity: relayId, signing_sk: relayKp.signing_secret_key, encryption_sk: relayKp.encryption_secret_key });
    this.identities.set('gateway', { identity: gatewayId, signing_sk: gatewayKp.signing_secret_key, encryption_sk: gatewayKp.encryption_secret_key });

    // P10: pre-link each demo node's email to their UniversalIdentity via a
    // signed CHANNEL_OWNERSHIP proof. In production, this would happen via
    // the user's email client signing a challenge; in the demo, the runtime
    // has the signing key so it signs directly.
    this.linkIdentityToChannel(aliceId, aliceKp, 'EMAIL', 'alice@example.com');
    this.linkIdentityToChannel(bobId, bobKp, 'EMAIL', 'bob@example.com');
    this.linkIdentityToChannel(relayId, relayKp, 'EMAIL', 'relay@example.com');
    this.linkIdentityToChannel(gatewayId, gatewayKp, 'EMAIL', 'gateway@example.com');

    const aliceCaps = advertiseCapabilities({
      node_id: 'alice',
      messaging: ['SEND', 'RECEIVE'],
      transport: ['BLE', 'LAN'],
    });
    const bobCaps = advertiseCapabilities({
      node_id: 'bob',
      messaging: ['RECEIVE'],
      transport: ['BLE', 'LAN'],
    });
    const relayCaps = advertiseCapabilities({
      node_id: 'relay',
      messaging: [],
      transport: ['LAN'],
      relay: ['STORE', 'FORWARD'],
      resource: { battery_pct: 80, storage_bytes: 1_000_000_000, bandwidth_bps: 1_000_000 },
      verification: 'PEER_CORROBORATED',
    });
    const gatewayCaps = advertiseCapabilities({
      node_id: 'gateway',
      messaging: [],
      transport: ['INTERNET', 'LAN'],
      relay: ['FORWARD'],
      gateway: ['EMAIL', 'SMS', 'WHATSAPP', 'MATRIX'],
      resource: { bandwidth_bps: 10_000_000, storage_bytes: 10_000_000_000, battery_pct: 100 },
      verification: 'TRUSTED',
    });

    // Alice: BLE to Bob, LAN to Relay
    const aliceBle = new LoopbackTransport({ node_id: 'alice', transport_type: 'BLE', peer_node_ids: ['bob'] }, busBle);
    const aliceLan = new LoopbackTransport({ node_id: 'alice', transport_type: 'LAN', peer_node_ids: ['relay'] }, busLan);
    this.transports.set('alice', [aliceBle, aliceLan]);

    // Bob: BLE to Alice, LAN to Relay
    const bobBle = new LoopbackTransport({ node_id: 'bob', transport_type: 'BLE', peer_node_ids: ['alice'] }, busBle);
    const bobLan = new LoopbackTransport({ node_id: 'bob', transport_type: 'LAN', peer_node_ids: ['relay'] }, busLan);
    this.transports.set('bob', [bobBle, bobLan]);

    // Relay: LAN to Alice and Bob on busLan; LAN to Gateway on busGw
    const relayLanToPeers = new LoopbackTransport({ node_id: 'relay', transport_type: 'LAN', peer_node_ids: ['alice', 'bob'] }, busLan);
    const relayLanToGw = new LoopbackTransport({ node_id: 'relay', transport_type: 'LAN', peer_node_ids: ['gateway'] }, busGw);
    this.transports.set('relay', [relayLanToPeers, relayLanToGw]);

    const gatewayLanToRelay = new LoopbackTransport({ node_id: 'gateway', transport_type: 'LAN', peer_node_ids: ['relay'] }, busGw);
    this.transports.set('gateway', [gatewayLanToRelay]);

    // Each node gets its signing key so relays can sign RELAY_FORWARD proofs.
    const makeStore = (node_id: string): BundleStore =>
      this.persistent ? createPrismaBundleStore({ node_id }) : createInMemoryBundleStore();

    // P5: each node gets its own capability cache for gossiped peer capabilities.
    const makeCache = (): CapabilityCache => createCapabilityCache();

    const aliceRT = createNodeRuntime({
      identity: aliceId,
      capabilities: aliceCaps,
      transports: this.transports.get('alice')!,
      bundleStore: makeStore('alice'),
      signing_secret_key: aliceKp.signing_secret_key,
      capabilityCache: makeCache(),
      onDelivered: (bundle, from) => this.handleDelivered('alice', bundle, from),
    });
    const bobRT = createNodeRuntime({
      identity: bobId,
      capabilities: bobCaps,
      transports: this.transports.get('bob')!,
      bundleStore: makeStore('bob'),
      signing_secret_key: bobKp.signing_secret_key,
      capabilityCache: makeCache(),
      onDelivered: (bundle, from) => this.handleDelivered('bob', bundle, from),
    });
    const relayRT = createNodeRuntime({
      identity: relayId,
      capabilities: relayCaps,
      transports: this.transports.get('relay')!,
      bundleStore: makeStore('relay'),
      signing_secret_key: relayKp.signing_secret_key,
      capabilityCache: makeCache(),
      onDelivered: (bundle, from) => this.handleDelivered('relay', bundle, from),
    });
    // P6+P8: Gateway runtime with EmailAdapter + SmsAdapter + WhatsappAdapter
    // (all EXPERIMENTAL — in-process transcripts). The gateway node advertises
    // EMAIL, SMS, WHATSAPP gateway capabilities. When a bundle with
    // recipient.kind === 'CHANNEL' arrives at the gateway, the gateway runtime
    // delegates to the matching adapter.
    const emailTranscript: EmailTranscript = { entries: [] };
    this.emailTranscript = emailTranscript;
    const smsTranscript: SmsTranscript = { entries: [] };
    this.smsTranscript = smsTranscript;
    const whatsappTranscript: WhatsappTranscript = { entries: [] };
    this.whatsappTranscript = whatsappTranscript;

    const emailAdapter = new EmailAdapter({
      adapter_id: 'email-adapter-demo',
      from_address: 'gateway@universal-comm-os.demo',
      transcript: emailTranscript,
    });
    const smsAdapter = new SmsAdapter({
      adapter_id: 'sms-adapter-demo',
      from_number: '+15550000000',
      transcript: smsTranscript,
    });
    const whatsappAdapter = new WhatsappAdapter({
      adapter_id: 'whatsapp-adapter-demo',
      from_number: '+15550000000',
      transcript: whatsappTranscript,
    });
    const gatewayRuntime = createGatewayRuntime();
    gatewayRuntime.registerAdapter(emailAdapter);
    gatewayRuntime.registerAdapter(smsAdapter);
    gatewayRuntime.registerAdapter(whatsappAdapter);
    this.gatewayRuntimes.set('gateway', gatewayRuntime);

    const gatewayRT = createNodeRuntime({
      identity: gatewayId,
      capabilities: gatewayCaps,
      transports: this.transports.get('gateway')!,
      bundleStore: makeStore('gateway'),
      signing_secret_key: gatewayKp.signing_secret_key,
      gatewayRuntime,
      capabilityCache: makeCache(),
    });

    this.runtimes.set('alice', aliceRT);
    this.runtimes.set('bob', bobRT);
    this.runtimes.set('relay', relayRT);
    this.runtimes.set('gateway', gatewayRT);
  }

  listNodes(): NodeDescriptor[] {
    return Array.from(this.runtimes.values()).map((rt) => {
      const entry = this.identities.get(rt.node_id)!;
      return {
        node_id: rt.node_id,
        display_name: entry.identity.display_name ?? rt.node_id,
        roles: deriveRoles(rt.capabilities),
        capabilities: rt.capabilities,
        identity: entry.identity,
        peers: this.transports.get(rt.node_id)?.flatMap((t) => (t as any).peers ? Array.from((t as any).peers as Set<string>) : []) ?? [],
      };
    });
  }

  networkState(): NetworkState {
    const nodes = this.listNodes().map((n) => ({
      node_id: n.node_id,
      display_name: n.display_name,
      roles: n.roles,
    }));
    const links: Array<{ from: string; to: string; transport: string }> = [];
    const seen = new Set<string>();
    for (const [nodeId, ts] of this.transports.entries()) {
      for (const t of ts) {
        const peerSet: Set<string> = (t as any).peers ?? new Set();
        for (const p of peerSet) {
          const key = [nodeId, p].sort().join('|') + '|' + t.transport_type;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ from: nodeId, to: p, transport: t.transport_type });
        }
      }
    }
    const capabilities: Record<string, NodeCapabilities> = {};
    for (const n of this.listNodes()) capabilities[n.node_id] = n.capabilities;
    return { nodes, links, capabilities };
  }

  async dispatch(req: DispatchRequest): Promise<DispatchResponse> {
    const senderRT = this.runtimes.get(req.from_node_id);
    if (!senderRT) return { status: 'ERROR', error: `Unknown from_node_id: ${req.from_node_id}` };
    if (!req.to_node_id && !req.to_channel) {
      return { status: 'ERROR', error: 'Must specify either to_node_id or to_channel' };
    }
    if (req.to_node_id && req.to_channel) {
      return { status: 'ERROR', error: 'Cannot specify both to_node_id and to_channel' };
    }
    const senderEntry = this.identities.get(req.from_node_id)!;

    // P6: For channel recipients, the bundle's payload is end-to-end encrypted
    // to a key the channel recipient can decrypt with. In a real deployment,
    // this would be a key pre-arranged between the sender and the recipient
    // (e.g., looked up via P10 identity graph). For the demo, we synthesize a
    // "channel identity" keypair per (channel, channel_id) — same input always
    // produces the same keypair so the recipient's email client can decrypt.
    let recipientEncryptionPubkey: Uint8Array;
    let recipientRef: { id: string; signing_pubkey_hash: string; display_name?: string };
    let recipientDescriptor: string;
    let conversationId: string;
    let destinationInput: { node_id?: string; channel?: string; channel_id?: string } | undefined;

    if (req.to_node_id) {
      const recipientEntry = this.identities.get(req.to_node_id);
      if (!recipientEntry) return { status: 'ERROR', error: `Unknown to_node_id: ${req.to_node_id}` };
      recipientEncryptionPubkey = recipientEntry.identity.public_keys.encryption_pubkey;
      recipientRef = toRef(recipientEntry.identity);
      recipientDescriptor = recipientEntry.identity.id;
      conversationId = req.conversation_id ?? `conv:${req.from_node_id}:${req.to_node_id}`;
      destinationInput = { node_id: req.to_node_id };
    } else {
      // P10: Channel recipient. Look up the recipient's real pubkey via the
      // IdentityGraph. If no verified link exists, fall back to the
      // synthesized keypair (backward-compat hack; in production, the
      // dispatcher would refuse to send to an unverified recipient).
      const resolved = this.resolveChannelRecipient(req.to_channel!.channel, req.to_channel!.channel_id);
      if (resolved) {
        recipientEncryptionPubkey = resolved.encryption_pubkey;
        recipientRef = resolved.identity_ref;
      } else {
        const synth = synthesizeChannelIdentity(req.to_channel!.channel, req.to_channel!.channel_id);
        recipientEncryptionPubkey = synth.pubkey;
        recipientRef = {
          id: synth.identity_id,
          signing_pubkey_hash: synth.signing_pubkey_hash,
        };
      }
      recipientDescriptor = `${req.to_channel!.channel}:${req.to_channel!.channel_id}`;
      conversationId = req.conversation_id ?? `conv:${req.from_node_id}:${recipientDescriptor}`;
      destinationInput = {
        channel: req.to_channel!.channel,
        channel_id: req.to_channel!.channel_id,
      };
    }

    const intent = createIntent({
      type: req.intent_type,
      priority: req.priority,
      ttl_ms: 60_000,
    });

    // Build the bundle first (so we have the canonical bundle_id), then seal.
    const now = Date.now();
    const expires_at = now + 60_000;

    // To seal, we need a placeholder bundle_id; we'll re-seal after createBundle
    // assigns the real UUID (canonical envelope binds bundle_id into additional_data).
    const tempEnvelope = sealPayload({
      bundle_id: 'pending',
      intent_type: intent.type,
      expires_at,
      sender: toRef(senderEntry.identity),
      recipient_encryption_pubkey: recipientEncryptionPubkey,
      plaintext: utf8Encode(req.plaintext),
    });

    const recipient = req.to_node_id
      ? { kind: 'IDENTITY' as const, ref: toRef(this.identities.get(req.to_node_id)!.identity) }
      : { kind: 'CHANNEL' as const, channel: req.to_channel!.channel, channel_id: req.to_channel!.channel_id };

    const bundle = createBundle({
      sender: toRef(senderEntry.identity),
      recipient,
      conversation_id: conversationId,
      intent,
      encryption_metadata: tempEnvelope.encryption_metadata,
      payload: tempEnvelope.payload,
      created_at: now,
      expires_at,
      routing_policy: {
        policy_id: defaultPolicy.policy_id,
        inline: {
          replication_factor: req.replicate ? 3 : 1,
          max_hops: defaultPolicy.max_hops,
          require_e2e: defaultPolicy.require_e2e,
        },
      },
    });

    // Re-seal with the real bundle_id so the AEAD additional_data binding matches.
    const realEnv = sealPayload({
      bundle_id: bundle.bundle_id,
      intent_type: intent.type,
      expires_at: bundle.expires_at,
      sender: toRef(senderEntry.identity),
      recipient_encryption_pubkey: recipientEncryptionPubkey,
      plaintext: utf8Encode(req.plaintext),
    });
    const signedBundle: CommunicationBundle = {
      ...bundle,
      encryption_metadata: realEnv.encryption_metadata,
      payload: realEnv.payload,
    };

    const senderProof = signProof(
      'SENDER_SIGNATURE',
      {
        bundle_id: signedBundle.bundle_id,
        sender_id: signedBundle.sender.id,
        sender_signing_pubkey_hash: signedBundle.sender.signing_pubkey_hash,
        recipient_kind: signedBundle.recipient.kind,
        recipient_descriptor: recipientDescriptor,
        conversation_id: signedBundle.conversation_id,
        intent_type: signedBundle.intent.type,
        priority: signedBundle.intent.priority,
        created_at: signedBundle.created_at,
        expires_at: signedBundle.expires_at,
        algorithm: signedBundle.encryption_metadata.algorithm,
        recipient_pubkey_hash: signedBundle.encryption_metadata.recipient_pubkey_hash,
        nonce: signedBundle.encryption_metadata.nonce,
        additional_data: signedBundle.encryption_metadata.additional_data,
        payload_bytes_len: signedBundle.payload.bytes_len,
        routing_policy_id: signedBundle.routing_policy.policy_id,
        replication_factor: signedBundle.routing_policy.inline.replication_factor,
        max_hops: signedBundle.routing_policy.inline.max_hops,
        require_e2e: signedBundle.routing_policy.inline.require_e2e,
      },
      toRef(senderEntry.identity),
      senderEntry.signing_sk,
    );

    const bundleWithProof: CommunicationBundle = {
      ...signedBundle,
      proofs: [senderProof],
    };

    this.dispatchedBundles.set(bundleWithProof.bundle_id, {
      bundle: bundleWithProof,
      from_node_id: req.from_node_id,
      plaintext: req.plaintext,
    });

    const result = await senderRT.dispatch({
      bundle: bundleWithProof,
      destination: destinationInput,
      replicate: req.replicate,
    });

    return {
      status: result.status,
      bundle_id: bundleWithProof.bundle_id,
      replicas_sent: result.replicas_sent,
      route_plan: result.plan
        ? {
            hops: result.plan.hops.map((h) => ({
              kind: h.kind,
              to_node_id: h.to_node_id,
              transport: h.transport,
              gateway: h.gateway,
              est_reliability: h.est_reliability,
              est_latency_ms: h.est_latency_ms,
              est_cost: h.est_cost,
            })),
            rationale: result.plan.rationale,
            est_reliability: result.plan.est_reliability,
            est_latency_ms: result.plan.est_latency_ms,
            est_cost: result.plan.est_cost,
          }
        : undefined,
      error: result.error,
    };
  }

  /** P6: expose the email transcript for UI rendering. */
  emailTranscriptEntries(): EmailTranscriptEntry[] {
    return [...this.emailTranscript.entries];
  }

  /** P8: expose the SMS transcript for UI rendering. */
  smsTranscriptEntries(): SmsTranscriptEntry[] {
    return [...this.smsTranscript.entries];
  }

  /** P8: expose the WhatsApp transcript for UI rendering. */
  whatsappTranscriptEntries(): WhatsappTranscriptEntry[] {
    return [...this.whatsappTranscript.entries];
  }

  /**
   * Snapshot delivery state across all nodes. P3: now per (bundle, node).
   * In persistent mode, the snapshot comes from the DB; in-memory mode reads
   * from each runtime's tracker.
   */
  async deliverySnapshots(): Promise<DeliverySnapshot[]> {
    // The in-memory per-node delivery tracker is the LIVE source of truth
    // for the delivery state machine (ARCH-012). The Prisma-backed tracker
    // is for forensic/restart recovery — keep them in sync via the sweeper.
    const out: DeliverySnapshot[] = [];
    for (const rt of this.runtimes.values()) {
      for (const r of rt.delivery.snapshot()) {
        out.push({
          bundle_id: r.bundle_id,
          node_id: rt.node_id,
          current: r.current,
          history: r.history.map((h) => ({
            ts: h.ts, from: h.from, to: h.to, node: h.node, transport: h.transport, note: h.note,
          })),
          updated_at: r.updated_at,
        });
      }
    }
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
  }

  bundleById(bundle_id: string): { bundle: CommunicationBundle; from_node_id: string; plaintext: string } | undefined {
    return this.dispatchedBundles.get(bundle_id);
  }

  tryDecrypt(bundle_id: string, at_node_id: string): { ok: boolean; plaintext?: string; reason?: string } {
    const entry = this.dispatchedBundles.get(bundle_id);
    if (!entry) return { ok: false, reason: 'unknown bundle' };
    const nodeEntry = this.identities.get(at_node_id);
    if (!nodeEntry) return { ok: false, reason: 'unknown node' };

    const env = { encryption_metadata: entry.bundle.encryption_metadata, payload: entry.bundle.payload };
    if (!isRecipientFor(env, nodeEntry.identity.public_keys.encryption_pubkey)) {
      return { ok: false, reason: 'this node is not the recipient (recipient_pubkey_hash mismatch)' };
    }
    try {
      const pt = openSealedPayload(env, nodeEntry.encryption_sk);
      return { ok: true, plaintext: utf8Decode(pt) };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  markRead(bundle_id: string, at_node_id: string): { ok: boolean; reason?: string } {
    const rt = this.runtimes.get(at_node_id);
    if (!rt) return { ok: false, reason: 'unknown node' };
    try {
      rt.delivery.transition(bundle_id, 'READ', { node: at_node_id });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  async queuedBundles(): Promise<Array<{ node_id: string; bundle_id: string; queued_at: number; nextHop: string }>> {
    const out: Array<{ node_id: string; bundle_id: string; queued_at: number; nextHop: string }> = [];
    for (const [id, rt] of this.runtimes.entries()) {
      for (const q of await rt.queuedBundles()) {
        out.push({ node_id: id, bundle_id: q.bundle.bundle_id, queued_at: q.queued_at, nextHop: q.nextHop });
      }
    }
    return out;
  }

  /**
   * Return the proof chain for a bundle: SENDER_SIGNATURE + any RELAY_FORWARD proofs
   * appended by relays. Verifies each proof against the corresponding signer's public key.
   */
  async relayForwardProofs(bundle_id: string): Promise<RelayForwardProofView | undefined> {
    const entry = this.dispatchedBundles.get(bundle_id);
    if (!entry) return undefined;
    const proofs = entry.bundle.proofs ?? [];

    const verifiedProofs = proofs.map((p) => {
      let verified = false;
      // Find the signer's identity to fetch the public key.
      for (const { identity } of this.identities.values()) {
        if (identity.signing_pubkey_hash === p.signer.signing_pubkey_hash) {
          try {
            verified = verifyProof(
              p,
              // For SENDER_SIGNATURE: same fields as in dispatch().
              // For RELAY_FORWARD: same fields as in tryForward().
              // We approximate verification by canonical fields; for the demo, we
              // just check the signature's structure and that the public key matches.
              p.kind === 'SENDER_SIGNATURE'
                ? { bundle_id: entry.bundle.bundle_id }
                : { bundle_id: entry.bundle.bundle_id, ts: p.ts },
              identity.public_keys.signing_pubkey,
            );
          } catch {
            verified = false;
          }
          break;
        }
      }
      return {
        kind: p.kind,
        signer_id: p.signer.id,
        ts: p.ts,
        verified,
      };
    });

    return {
      bundle_id,
      proofs: verifiedProofs,
    };
  }

  async sweepOnce() {
    const result = await this.sweeper.sweepOnce();
    // Mirror the EXPIRED transitions to each node's in-memory tracker so the
    // UI sees them (ARCH-022: dual-located delivery tracker).
    for (const rt of this.runtimes.values()) {
      try {
        // For each expired bundle in this node's store, mark EXPIRED in the
        // in-memory tracker if the bundle has a tracker entry and is in QUEUED state.
        for (const q of await rt.queuedBundles()) {
          const existing = rt.delivery.get(q.bundle.bundle_id);
          if (existing && existing.current === 'QUEUED') {
            try {
              rt.delivery.transition(q.bundle.bundle_id, 'EXPIRED', {
                node: rt.node_id,
                note: 'TTL sweeper',
              });
            } catch {
              // State machine rejected — likely already terminal. Skip.
            }
          }
        }
      } catch {
        // Runtime store may be in-memory only (no queuedBundles persistence). Skip.
      }
    }
    return result;
  }

  sweeperStatus() {
    return {
      running: this.sweeper.isRunning(),
      last: this.sweeper.lastSweep(),
    };
  }

  async reset() {
    this.runtimes.clear();
    this.identities.clear();
    this.buses.clear();
    this.transports.clear();
    this.dispatchedBundles.clear();
    this.gatewayRuntimes.clear();
    this.emailTranscript = { entries: [] };
    this.smsTranscript = { entries: [] };
    this.whatsappTranscript = { entries: [] };
    this.identityGraph.clear();
    this.inbox.clear();
    // Clear persistent tables too so the demo starts fresh.
    if (this.persistent) {
      await db.storedBundle.deleteMany({});
      await db.receivedBundle.deleteMany({});
      await db.deliveryEvent.deleteMany({});
    }
    this.sweeper.stop();
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
      this.gossipTimer = null;
    }
    this.setup();
    if (this.persistent) this.sweeper.start();
    // P5: restart gossip for the fresh network.
    this.gossipAll();
    this.gossipTimer = setInterval(() => this.gossipAll(), 5_000);
  }
}

/**
 * P6: synthesize a deterministic identity keypair for a channel recipient.
 * Same (channel, channel_id) always produces the same keypair, so the
 * recipient's email client can decrypt any bundle sent to that address.
 *
 * NOTE: This is a DEMO mechanism. In production, the sender would look up
 * the recipient's published encryption pubkey via the P10 identity graph.
 */
function synthesizeChannelIdentity(channel: string, channel_id: string): {
  identity_id: string;
  pubkey: Uint8Array;
  signing_pubkey_hash: string;
} {
  const seedStr = `universal-comm-os|${channel}|${channel_id}`;
  const seedBytes = new TextEncoder().encode(seedStr);
  // Hash to 32 bytes for use as a NaCl X25519 secret key seed.
  const seed = sha256(seedBytes);
  const keypair = nacl.box.keyPair.fromSecretKey(seed);
  const identity_id = `channel-identity:${channel}:${channel_id}`;
  return {
    identity_id,
    pubkey: keypair.publicKey,
    signing_pubkey_hash: b64urlEncode(sha256(keypair.publicKey)),
  };
}

export function getNetwork(): SimulatedNetwork {
  if (!_network) {
    _network = new SimulatedNetwork({ persistent: true });
  }
  return _network;
}
