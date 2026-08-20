/**
 * P5 Multi-hop Edge tests.
 *
 * Proves: A → B → C → D where Alice's router plans the full multi-hop route
 * proactively using the gossiped capability cache.
 *
 * Per ROADMAP P5: "A → B → C → D where only some nodes have connectivity.
 * Capability gossip over local transports."
 *
 * This retires the ARCH-027 epidemic-routing fallback when the cache is
 * healthy. The router now picks a specific peer (not all peers) for the
 * first hop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
  createCapabilityCache,
  type UniversalIdentity,
  type CommunicationBundle,
  type CapabilityAdvertisement,
} from '@/core/index';
import { LoopbackBus, LoopbackTransport } from '@/transport/loopback/LoopbackTransport';
import { createNodeRuntime, createInMemoryBundleStore as createMemStore, type NodeRuntime } from '@/server/NodeRuntime';
import { utf8Encode, utf8Decode } from '@/core/util/encoding';

// 4-node chain topology:
//   A (alice) — LAN — B (bob) — LAN — C (carol) — LAN — D (dave)
//
// Each bus carries TWO nodes only (no shared buses). This forces multi-hop:
// Alice can only reach Bob directly; to reach Dave, the bundle must traverse
// Bob → Carol → Dave.

describe('P5 — Multi-hop edge with capability gossip (A → B → C → D)', () => {
  let busAB: LoopbackBus;
  let busBC: LoopbackBus;
  let busCD: LoopbackBus;
  let aliceRT: NodeRuntime;
  let bobRT: NodeRuntime;
  let carolRT: NodeRuntime;
  let daveRT: NodeRuntime;
  let aliceId: UniversalIdentity;
  let daveId: UniversalIdentity;
  let aliceKp: any;
  let daveKp: any;

  beforeEach(() => {
    busAB = new LoopbackBus();
    busBC = new LoopbackBus();
    busCD = new LoopbackBus();

    const aliceK = generateIdentityKeyPair();
    const bobK = generateIdentityKeyPair();
    const carolK = generateIdentityKeyPair();
    const daveK = generateIdentityKeyPair();
    aliceKp = aliceK;
    daveKp = daveK;
    aliceId = createUniversalIdentity({ display_name: 'Alice', key_set: aliceK.key_set });
    const bobId = createUniversalIdentity({ display_name: 'Bob', key_set: bobK.key_set });
    const carolId = createUniversalIdentity({ display_name: 'Carol', key_set: carolK.key_set });
    daveId = createUniversalIdentity({ display_name: 'Dave', key_set: daveK.key_set });

    // Each node has ONE transport per bus it's on.
    const aliceT = new LoopbackTransport({ node_id: 'alice', transport_type: 'LAN', peer_node_ids: ['bob'] }, busAB);
    const bobT1 = new LoopbackTransport({ node_id: 'bob', transport_type: 'LAN', peer_node_ids: ['alice'] }, busAB);
    const bobT2 = new LoopbackTransport({ node_id: 'bob', transport_type: 'LAN', peer_node_ids: ['carol'] }, busBC);
    const carolT1 = new LoopbackTransport({ node_id: 'carol', transport_type: 'LAN', peer_node_ids: ['bob'] }, busBC);
    const carolT2 = new LoopbackTransport({ node_id: 'carol', transport_type: 'LAN', peer_node_ids: ['dave'] }, busCD);
    const daveT = new LoopbackTransport({ node_id: 'dave', transport_type: 'LAN', peer_node_ids: ['carol'] }, busCD);

    // Each node has its own capability cache (gossiped view).
    const aliceCache = createCapabilityCache();
    const bobCache = createCapabilityCache();
    const carolCache = createCapabilityCache();
    const daveCache = createCapabilityCache();

    aliceRT = createNodeRuntime({
      identity: aliceId,
      capabilities: advertiseCapabilities({ node_id: 'alice', messaging: ['SEND'], transport: ['LAN'] }),
      transports: [aliceT],
      bundleStore: createMemStore(),
      signing_secret_key: aliceK.signing_secret_key,
      capabilityCache: aliceCache,
    });
    bobRT = createNodeRuntime({
      identity: bobId,
      capabilities: advertiseCapabilities({ node_id: 'bob', transport: ['LAN'], relay: ['STORE', 'FORWARD'], verification: 'PEER_CORROBORATED' }),
      transports: [bobT1, bobT2],
      bundleStore: createMemStore(),
      signing_secret_key: bobK.signing_secret_key,
      capabilityCache: bobCache,
    });
    carolRT = createNodeRuntime({
      identity: carolId,
      capabilities: advertiseCapabilities({ node_id: 'carol', transport: ['LAN'], relay: ['STORE', 'FORWARD'], verification: 'PEER_CORROBORATED' }),
      transports: [carolT1, carolT2],
      bundleStore: createMemStore(),
      signing_secret_key: carolK.signing_secret_key,
      capabilityCache: carolCache,
    });
    daveRT = createNodeRuntime({
      identity: daveId,
      capabilities: advertiseCapabilities({ node_id: 'dave', messaging: ['RECEIVE'], transport: ['LAN'] }),
      transports: [daveT],
      bundleStore: createMemStore(),
      signing_secret_key: daveK.signing_secret_key,
      capabilityCache: daveCache,
    });
  });

  it('gossip propagates capabilities across the chain (A learns about D via B→C)', () => {
    // Initially, Alice's cache is empty.
    expect(aliceRT.capabilityCacheSnapshot().length).toBe(0);

    // Each node gossips its own capabilities to direct peers.
    aliceRT.gossipCapabilities();
    bobRT.gossipCapabilities();
    carolRT.gossipCapabilities();
    daveRT.gossipCapabilities();

    // After one gossip round, Alice should know about Bob (direct).
    // Bob should know about Alice and Carol. Carol should know about Bob and Dave.
    // Dave should know about Carol.
    expect(aliceRT.capabilityCacheSnapshot().some((a) => a.origin_node_id === 'bob')).toBe(true);
    expect(bobRT.capabilityCacheSnapshot().some((a) => a.origin_node_id === 'alice')).toBe(true);
    expect(bobRT.capabilityCacheSnapshot().some((a) => a.origin_node_id === 'carol')).toBe(true);
    expect(carolRT.capabilityCacheSnapshot().some((a) => a.origin_node_id === 'dave')).toBe(true);

    // Bob and Carol should rebroadcast (gossip propagation). After propagation,
    // Alice should know about Carol (via Bob's rebroadcast) and Dave (via Carol's).
    // Give microtasks a chance to settle.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const aliceKnown = aliceRT.capabilityCacheSnapshot().map((a) => a.origin_node_id);
        expect(aliceKnown).toContain('bob');
        expect(aliceKnown).toContain('carol');
        expect(aliceKnown).toContain('dave');
        resolve();
      }, 50);
    });
  });

  it('routes a bundle A → B → C → D using the gossiped network view', async () => {
    // Step 1: gossip to populate caches.
    aliceRT.gossipCapabilities();
    bobRT.gossipCapabilities();
    carolRT.gossipCapabilities();
    daveRT.gossipCapabilities();

    // Wait for propagation.
    await new Promise((r) => setTimeout(r, 100));

    // Step 2: Alice composes a bundle to Dave's identity.
    const intent = createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 });
    const now = Date.now();
    const expires_at = now + 60_000;
    const env = sealPayload({
      bundle_id: 'pending',
      intent_type: intent.type,
      expires_at,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: daveId.public_keys.encryption_pubkey,
      plaintext: utf8Encode('Multi-hop test — A → B → C → D'),
    });
    const bundle = createBundle({
      sender: toRef(aliceId),
      recipient: { kind: 'IDENTITY', ref: toRef(daveId) },
      conversation_id: 'conv-multihop',
      intent,
      encryption_metadata: env.encryption_metadata,
      payload: env.payload,
      created_at: now,
      expires_at,
      routing_policy: {
        policy_id: defaultPolicy.policy_id,
        inline: { replication_factor: 1, max_hops: 4, require_e2e: true },
      },
    });
    const realEnv = sealPayload({
      bundle_id: bundle.bundle_id,
      intent_type: intent.type,
      expires_at: bundle.expires_at,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: daveId.public_keys.encryption_pubkey,
      plaintext: utf8Encode('Multi-hop test — A → B → C → D'),
    });
    const senderProof = signProof(
      'SENDER_SIGNATURE',
      {
        bundle_id: bundle.bundle_id,
        sender_id: bundle.sender.id,
        sender_signing_pubkey_hash: bundle.sender.signing_pubkey_hash,
        recipient_kind: bundle.recipient.kind,
        recipient_descriptor: bundle.recipient.kind === 'IDENTITY' ? bundle.recipient.ref.id : 'other',
        conversation_id: bundle.conversation_id,
        intent_type: bundle.intent.type,
        priority: bundle.intent.priority,
        created_at: bundle.created_at,
        expires_at: bundle.expires_at,
        algorithm: bundle.encryption_metadata.algorithm,
        recipient_pubkey_hash: bundle.encryption_metadata.recipient_pubkey_hash,
        nonce: bundle.encryption_metadata.nonce,
        additional_data: bundle.encryption_metadata.additional_data,
        payload_bytes_len: bundle.payload.bytes_len,
        routing_policy_id: bundle.routing_policy.policy_id,
        replication_factor: bundle.routing_policy.inline.replication_factor,
        max_hops: bundle.routing_policy.inline.max_hops,
        require_e2e: bundle.routing_policy.inline.require_e2e,
      },
      toRef(aliceId),
      aliceKp.signing_secret_key,
    );
    const bundleWithProof: CommunicationBundle = {
      ...bundle,
      encryption_metadata: realEnv.encryption_metadata,
      payload: realEnv.payload,
      proofs: [senderProof],
    };

    // Step 3: Alice dispatches with destination = Dave's node_id.
    const result = await aliceRT.dispatch({
      bundle: bundleWithProof,
      destination: { node_id: 'dave' },
    });

    // The router should find a multi-hop plan (A → B → C → D).
    expect(result.status).toBe('DISPATCHED');
    expect(result.plan?.hops.length).toBeGreaterThanOrEqual(2);
    // The first hop should be to Bob (Alice's only direct peer).
    expect(result.plan?.hops[0].to_node_id).toBe('bob');

    // Wait for propagation through the chain.
    await new Promise((r) => setTimeout(r, 200));

    // Alice's side: RELAYED.
    expect(aliceRT.delivery.get(bundle.bundle_id)?.current).toBe('RELAYED');
    // Bob's side: RELAYED (forwarded onward).
    expect(bobRT.delivery.get(bundle.bundle_id)?.current).toBe('RELAYED');
    // Carol's side: RELAYED.
    expect(carolRT.delivery.get(bundle.bundle_id)?.current).toBe('RELAYED');
    // Dave's side: DELIVERED (recipient).
    expect(daveRT.delivery.get(bundle.bundle_id)?.current).toBe('DELIVERED');

    // Dave can decrypt the bundle.
    const env2 = { encryption_metadata: realEnv.encryption_metadata, payload: realEnv.payload };
    expect(isRecipientFor(env2, daveId.public_keys.encryption_pubkey)).toBe(true);
    const plaintext = openSealedPayload(env2, daveKp.encryption_secret_key);
    expect(utf8Decode(plaintext)).toBe('Multi-hop test — A → B → C → D');
  });
});
