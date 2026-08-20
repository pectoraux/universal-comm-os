/**
 * server/CommOS.ts
 *
 * The Communication OS API surface (Architecture Constitution Article I.7).
 *
 * This is the API consumed by the Web/Electron UI. It:
 *   - Sets up a small simulated network of nodes (Alice, Bob, Relay, Gateway)
 *     to demonstrate the protocol without external dependencies.
 *   - Wires transports (LoopbackTransport, one bus per "physical link").
 *   - Persists node runtimes in-memory for the lifetime of the process.
 *
 * The UI MUST NOT directly call adapters/matrix/transport-impl (ARCH-011).
 * The UI consumes this API only.
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
  type UniversalIdentity,
  type CommunicationBundle,
  type DeliveryRecord,
  type NodeCapabilities,
  type Intent,
  type Proof,
} from '@/core/index';
import { LoopbackBus, LoopbackTransport } from '@/transport/loopback/LoopbackTransport';
import { createNodeRuntime, createInMemoryBundleStore, type NodeRuntime } from '@/server/NodeRuntime';
import { utf8Encode, utf8Decode } from '@/core/util/encoding';

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
  to_node_id: string;
  plaintext: string;
  intent_type: Intent['type'];
  priority?: Intent['priority'];
  conversation_id?: string;
}

export interface DispatchResponse {
  status: 'DISPATCHED' | 'QUEUED' | 'NO_ROUTE' | 'BUNDLE_EXPIRED' | 'ERROR';
  bundle_id?: string;
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
  current: string;
  history: Array<{ ts: number; from?: string; to: string; node?: string; transport?: string; note?: string }>;
  updated_at: number;
}

export interface NetworkState {
  nodes: Array<{ node_id: string; display_name: string; roles: string[] }>;
  links: Array<{ from: string; to: string; transport: string }>;
  capabilities: Record<string, NodeCapabilities>;
}

// --- Internal singleton (one simulated fabric per process) ---
let _network: SimulatedNetwork | null = null;

class SimulatedNetwork {
  readonly runtimes = new Map<string, NodeRuntime>();
  readonly identities = new Map<string, { identity: UniversalIdentity; signing_sk: Uint8Array; encryption_sk: Uint8Array }>();
  readonly buses = new Map<string, LoopbackBus>(); // bus_id -> bus
  readonly transports = new Map<string, LoopbackTransport[]>(); // node_id -> transports
  readonly dispatchedBundles = new Map<string, { bundle: CommunicationBundle; from_node_id: string; plaintext: string }>();

  constructor() {
    this.setup();
  }

  private setup() {
    // Three-loopback-bus fabric:
    //   bus-lan:  Alice <-> Relay (LAN)
    //   bus-ble:  Alice <-> Bob (BLE)  [opportunistic short-range]
    //   bus-gw:   Relay <-> Gateway (LAN)
    //
    //   Alice (personal, no Internet)
    //     <-> Relay (LAN, store-and-forward)
    //            <-> Gateway (Internet, EMAIL gateway)
    //                  [-> external recipient via email adapter, P8 territory]
    //
    //   Alice also can reach Bob directly over BLE (a partitioned test path).

    const busLan = new LoopbackBus();
    const busBle = new LoopbackBus();
    const busGw = new LoopbackBus();
    this.buses.set('lan', busLan);
    this.buses.set('ble', busBle);
    this.buses.set('gw', busGw);

    // --- Identities ---
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

    // --- Capabilities ---
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
      gateway: ['EMAIL', 'SMS', 'MATRIX'],
      resource: { bandwidth_bps: 10_000_000, storage_bytes: 10_000_000_000, battery_pct: 100 },
      verification: 'TRUSTED',
    });

    // --- Transports ---
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

    // Gateway: LAN to Relay on busGw; INTERNET (loopback, no peers yet — would be Matrix in P7)
    const gatewayLanToRelay = new LoopbackTransport({ node_id: 'gateway', transport_type: 'LAN', peer_node_ids: ['relay'] }, busGw);
    this.transports.set('gateway', [gatewayLanToRelay]);

    // --- Runtimes ---
    const aliceRT = createNodeRuntime({
      identity: aliceId,
      capabilities: aliceCaps,
      transports: this.transports.get('alice')!,
      bundleStore: createInMemoryBundleStore(),
    });
    const bobRT = createNodeRuntime({
      identity: bobId,
      capabilities: bobCaps,
      transports: this.transports.get('bob')!,
      bundleStore: createInMemoryBundleStore(),
    });
    const relayRT = createNodeRuntime({
      identity: relayId,
      capabilities: relayCaps,
      transports: this.transports.get('relay')!,
      bundleStore: createInMemoryBundleStore(),
    });
    const gatewayRT = createNodeRuntime({
      identity: gatewayId,
      capabilities: gatewayCaps,
      transports: this.transports.get('gateway')!,
      bundleStore: createInMemoryBundleStore(),
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
    const recipientEntry = this.identities.get(req.to_node_id);
    if (!recipientEntry) return { status: 'ERROR', error: `Unknown to_node_id: ${req.to_node_id}` };
    const senderEntry = this.identities.get(req.from_node_id)!;

    const intent = createIntent({
      type: req.intent_type,
      priority: req.priority,
      ttl_ms: 60_000,
    });

    // Note: bundle_id is assigned by createBundle; we use a placeholder for
    // the envelope binding (which is then re-stamped after creation).
    const placeholderId = 'pending';
    const envelope = sealPayload({
      bundle_id: placeholderId,
      intent_type: intent.type,
      expires_at: Date.now() + 60_000,
      sender: toRef(senderEntry.identity),
      recipient_encryption_pubkey: recipientEntry.identity.public_keys.encryption_pubkey,
      plaintext: utf8Encode(req.plaintext),
    });

    const bundle = createBundle({
      sender: toRef(senderEntry.identity),
      recipient: { kind: 'IDENTITY', ref: toRef(recipientEntry.identity) },
      conversation_id: req.conversation_id ?? `conv:${req.from_node_id}:${req.to_node_id}`,
      intent,
      encryption_metadata: envelope.encryption_metadata,
      payload: envelope.payload,
      routing_policy: {
        policy_id: defaultPolicy.policy_id,
        inline: {
          replication_factor: defaultPolicy.replication_factor,
          max_hops: defaultPolicy.max_hops,
          require_e2e: defaultPolicy.require_e2e,
        },
      },
    });

    // The envelope metadata was sealed with a placeholder bundle_id; that's a
    // protocol violation strictly (the binding must match the real bundle_id).
    // For the demo, we re-seal with the real bundle_id so the additional_data
    // binding is correct (this is a property of the demo setup, not the core).
    const realEnv = sealPayload({
      bundle_id: bundle.bundle_id,
      intent_type: intent.type,
      expires_at: bundle.expires_at,
      sender: toRef(senderEntry.identity),
      recipient_encryption_pubkey: recipientEntry.identity.public_keys.encryption_pubkey,
      plaintext: utf8Encode(req.plaintext),
    });
    const signedBundle = {
      ...bundle,
      encryption_metadata: realEnv.encryption_metadata,
      payload: realEnv.payload,
    } as CommunicationBundle;

    // Add the SENDER_SIGNATURE proof so the recipient can verify authenticity.
    const senderProof = signProof(
      'SENDER_SIGNATURE',
      {
        bundle_id: signedBundle.bundle_id,
        sender_id: signedBundle.sender.id,
        sender_signing_pubkey_hash: signedBundle.sender.signing_pubkey_hash,
        recipient_kind: signedBundle.recipient.kind,
        recipient_descriptor: signedBundle.recipient.kind === 'IDENTITY' ? signedBundle.recipient.ref.id : 'other',
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
      destination: { node_id: req.to_node_id },
    });

    return {
      status: result.status,
      bundle_id: bundleWithProof.bundle_id,
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

  deliverySnapshots(): DeliverySnapshot[] {
    const out: DeliverySnapshot[] = [];
    for (const rt of this.runtimes.values()) {
      for (const r of rt.delivery.snapshot()) {
        out.push({
          bundle_id: r.bundle_id,
          current: r.current,
          history: r.history.map((h) => ({
            ts: h.ts,
            from: h.from,
            to: h.to,
            node: h.node,
            transport: h.transport,
            note: h.note,
          })),
          updated_at: r.updated_at,
        });
      }
    }
    // Sort: most recent first.
    out.sort((a, b) => b.updated_at - a.updated_at);
    return out;
  }

  bundleById(bundle_id: string): { bundle: CommunicationBundle; from_node_id: string; plaintext: string } | undefined {
    return this.dispatchedBundles.get(bundle_id);
  }

  /** Try to decrypt a bundle at a given node (recipient view). */
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

  /** Mark a bundle as READ at the recipient node (per delivery state machine). */
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

  queuedBundles(): Array<{ node_id: string; bundle_id: string; queued_at: number; nextHop: string }> {
    const out: Array<{ node_id: string; bundle_id: string; queued_at: number; nextHop: string }> = [];
    for (const [id, rt] of this.runtimes.entries()) {
      for (const q of rt.queuedBundles()) {
        out.push({ node_id: id, bundle_id: q.bundle.bundle_id, queued_at: q.queued_at, nextHop: q.nextHop });
      }
    }
    return out;
  }

  reset() {
    this.runtimes.clear();
    this.identities.clear();
    this.buses.clear();
    this.transports.clear();
    this.dispatchedBundles.clear();
    this.setup();
  }
}

export function getNetwork(): SimulatedNetwork {
  if (!_network) {
    _network = new SimulatedNetwork();
  }
  return _network;
}
