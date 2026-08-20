/**
 * P2 milestone integration test: Bundle -> transport -> destination WITHOUT Internet.
 *
 * Per ROADMAP P2: "Prove: Bundle -> transport -> destination".
 * Per master prompt §42 first technical milestone precursor.
 *
 * This test is the smallest runnable proof of the architecture's thesis.
 */

import { describe, it, expect } from 'vitest';
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
  type UniversalIdentity,
  type CommunicationBundle,
} from '@/core/index';
import { LoopbackBus, LoopbackTransport } from '@/transport/loopback/LoopbackTransport';
import { createNodeRuntime, createInMemoryBundleStore, type NodeRuntime } from '@/server/NodeRuntime';
import { utf8Encode } from '@/core/util/encoding';

describe('P2 milestone: Bundle → transport → destination (no Internet)', () => {
  it('delivers an encrypted bundle from A to B via LoopbackTransport', async () => {
    // --- Setup: two nodes, one bus (the "physical link"). ---
    const bus = new LoopbackBus();

    const aliceKp = generateIdentityKeyPair();
    const bobKp = generateIdentityKeyPair();
    const aliceId = createUniversalIdentity({ display_name: 'Alice', key_set: aliceKp.key_set });
    const bobId = createUniversalIdentity({ display_name: 'Bob', key_set: bobKp.key_set });

    const aliceTransport = new LoopbackTransport(
      { node_id: 'A', transport_type: 'LAN', peer_node_ids: ['B'] },
      bus,
    );
    const bobTransport = new LoopbackTransport(
      { node_id: 'B', transport_type: 'LAN', peer_node_ids: ['A'] },
      bus,
    );

    const aliceCapabilities = advertiseCapabilities({
      node_id: 'A',
      messaging: ['SEND', 'RECEIVE'],
      transport: ['LAN'],
    });
    const bobCapabilities = advertiseCapabilities({
      node_id: 'B',
      messaging: ['RECEIVE'],
      transport: ['LAN'],
    });

    const aliceRuntime: NodeRuntime = createNodeRuntime({
      identity: aliceId,
      capabilities: aliceCapabilities,
      transports: [aliceTransport],
      bundleStore: createInMemoryBundleStore(),
    });
    const bobRuntime: NodeRuntime = createNodeRuntime({
      identity: bobId,
      capabilities: bobCapabilities,
      transports: [bobTransport],
      bundleStore: createInMemoryBundleStore(),
    });

    // --- Alice composes a bundle to Bob ---
    const intent = createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 });
    const envelope = sealPayload({
      bundle_id: 'placeholder-id-not-used', // bundle_id is assigned by createBundle
      intent_type: intent.type,
      expires_at: Date.now() + 60_000,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: bobId.public_keys.encryption_pubkey,
      plaintext: utf8Encode('Hello, Bob! Encrypted over a LAN fabric.'),
    });

    const bundle: CommunicationBundle = createBundle({
      sender: toRef(aliceId),
      recipient: { kind: 'IDENTITY', ref: toRef(bobId) },
      conversation_id: 'conv-A-B-1',
      intent,
      encryption_metadata: envelope.encryption_metadata,
      payload: envelope.payload,
      routing_policy: {
        policy_id: defaultPolicy.policy_id,
        inline: {
          replication_factor: 1,
          max_hops: 4,
          require_e2e: true,
        },
      },
    });

    // Alice signs the bundle (sender signature proof).
    const senderProof = signProof(
      'SENDER_SIGNATURE',
      {
        bundle_id: bundle.bundle_id,
        sender_id: bundle.sender.id,
        sender_signing_pubkey_hash: bundle.sender.signing_pubkey_hash,
        recipient_kind: bundle.recipient.kind,
        recipient_descriptor:
          bundle.recipient.kind === 'IDENTITY'
            ? bundle.recipient.ref.id
            : 'other',
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

    // Verify the sender signature using Alice's public signing key.
    expect(
      verifyProof(senderProof, {
        bundle_id: bundle.bundle_id,
        sender_id: bundle.sender.id,
        sender_signing_pubkey_hash: bundle.sender.signing_pubkey_hash,
        recipient_kind: bundle.recipient.kind,
        recipient_descriptor:
          bundle.recipient.kind === 'IDENTITY' ? bundle.recipient.ref.id : 'other',
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
      }, aliceKp.key_set.signing_pubkey),
    ).toBe(true);

    // --- Alice dispatches the bundle to Bob ---
    const result = await aliceRuntime.dispatch({
      bundle,
      destination: { node_id: 'B' },
    });

    expect(result.status).toBe('DISPATCHED');
    expect(result.plan?.hops.length).toBe(1);

    // --- Delivery state assertions (ARCH-012) ---
    const aliceRec = aliceRuntime.delivery.get(bundle.bundle_id);
    expect(aliceRec?.current).toBe('RELAYED');

    // Give Bob's runtime a microtask to process the inbound bundle.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    const bobRec = bobRuntime.delivery.get(bundle.bundle_id);
    expect(bobRec?.current).toBe('DELIVERED');

    // --- Bob decrypts the bundle ---
    expect(isRecipientFor(envelope, bobId.public_keys.encryption_pubkey)).toBe(true);
    const plaintext = openSealedPayload(envelope, bobKp.encryption_secret_key);
    expect(new TextDecoder().decode(plaintext)).toBe(
      'Hello, Bob! Encrypted over a LAN fabric.',
    );

    // --- Bob marks READ ---
    bobRuntime.delivery.transition(bundle.bundle_id, 'READ', { node: 'B' });
    expect(bobRuntime.delivery.get(bundle.bundle_id)?.current).toBe('READ');
  });
});
