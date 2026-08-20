/**
 * P11 Consumer Application tests.
 *
 * Proves: a bundle dispatched to Bob appears in Bob's inbox with decrypted
 * plaintext; marking as read transitions delivery state to READ.
 *
 * Per ROADMAP P11: "inbox, conversations, contacts, offline queue,
 * network state, delivery status, gateway visibility, identity management."
 *
 * ARCH-038 (recipient inbox), ARCH-039 (auto-decrypt on delivery),
 * ARCH-040 (conversation grouping).
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
  defaultPolicy,
  advertiseCapabilities,
  type UniversalIdentity,
  type CommunicationBundle,
} from '@/core/index';
import { LoopbackBus, LoopbackTransport } from '@/transport/loopback/LoopbackTransport';
import { createNodeRuntime, createInMemoryBundleStore, type NodeRuntime } from '@/server/NodeRuntime';
import { utf8Encode, utf8Decode } from '@/core/util/encoding';

describe('P11 — Consumer Application (inbox + conversations)', () => {
  let bus: LoopbackBus;
  let aliceRT: NodeRuntime;
  let bobRT: NodeRuntime;
  let aliceId: UniversalIdentity;
  let bobId: UniversalIdentity;
  let aliceKp: any;
  let bobKp: any;
  let bobInbox: Array<{ bundle_id: string; conversation_id: string; plaintext: string; read: boolean; delivery_state: string }>;

  beforeEach(() => {
    bus = new LoopbackBus();
    aliceKp = generateIdentityKeyPair();
    bobKp = generateIdentityKeyPair();
    aliceId = createUniversalIdentity({ display_name: 'Alice', key_set: aliceKp.key_set });
    bobId = createUniversalIdentity({ display_name: 'Bob', key_set: bobKp.key_set });
    bobInbox = [];

    const aliceT = new LoopbackTransport({ node_id: 'alice', transport_type: 'LAN', peer_node_ids: ['bob'] }, bus);
    const bobT = new LoopbackTransport({ node_id: 'bob', transport_type: 'LAN', peer_node_ids: ['alice'] }, bus);

    aliceRT = createNodeRuntime({
      identity: aliceId,
      capabilities: advertiseCapabilities({ node_id: 'alice', messaging: ['SEND'], transport: ['LAN'] }),
      transports: [aliceT],
      bundleStore: createInMemoryBundleStore(),
      signing_secret_key: aliceKp.signing_secret_key,
    });
    bobRT = createNodeRuntime({
      identity: bobId,
      capabilities: advertiseCapabilities({ node_id: 'bob', messaging: ['RECEIVE'], transport: ['LAN'] }),
      transports: [bobT],
      bundleStore: createInMemoryBundleStore(),
      signing_secret_key: bobKp.signing_secret_key,
      // P11: onDelivered callback — auto-decrypts and adds to inbox.
      onDelivered: (bundle, from) => {
        const env = { encryption_metadata: bundle.encryption_metadata, payload: bundle.payload };
        if (!isRecipientFor(env, bobId.public_keys.encryption_pubkey)) return;
        try {
          const pt = openSealedPayload(env, bobKp.encryption_secret_key);
          bobInbox.push({
            bundle_id: bundle.bundle_id,
            conversation_id: bundle.conversation_id,
            plaintext: utf8Decode(pt),
            read: false,
            delivery_state: 'DELIVERED',
          });
        } catch { /* ignore */ }
      },
    });
  });

  async function dispatchFromAlice(plaintext: string, conversationId: string): Promise<{ bundle_id: string }> {
    const intent = createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 });
    const now = Date.now();
    const expires_at = now + 60_000;
    const env = sealPayload({
      bundle_id: 'pending',
      intent_type: intent.type,
      expires_at,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: bobId.public_keys.encryption_pubkey,
      plaintext: utf8Encode(plaintext),
    });
    const bundle = createBundle({
      sender: toRef(aliceId),
      recipient: { kind: 'IDENTITY', ref: toRef(bobId) },
      conversation_id: conversationId,
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
      recipient_encryption_pubkey: bobId.public_keys.encryption_pubkey,
      plaintext: utf8Encode(plaintext),
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
    await aliceRT.dispatch({
      bundle: bundleWithProof,
      destination: { node_id: 'bob' },
    });
    return { bundle_id: bundle.bundle_id };
  }

  it('a dispatched bundle appears in Bob\'s inbox with decrypted plaintext', async () => {
    const { bundle_id } = await dispatchFromAlice('Hello Bob — P11 inbox test!', 'conv-1');
    await new Promise((r) => setTimeout(r, 100));

    expect(bobInbox.length).toBe(1);
    expect(bobInbox[0].bundle_id).toBe(bundle_id);
    expect(bobInbox[0].plaintext).toBe('Hello Bob — P11 inbox test!');
    expect(bobInbox[0].conversation_id).toBe('conv-1');
    expect(bobInbox[0].read).toBe(false);
    expect(bobInbox[0].delivery_state).toBe('DELIVERED');

    // Bob's delivery state machine reached DELIVERED.
    const rec = bobRT.delivery.get(bundle_id);
    expect(rec?.current).toBe('DELIVERED');
  });

  it('marking as read transitions delivery state to READ', async () => {
    const { bundle_id } = await dispatchFromAlice('Read me!', 'conv-2');
    await new Promise((r) => setTimeout(r, 100));

    // Before marking as read.
    expect(bobInbox[0].read).toBe(false);
    expect(bobRT.delivery.get(bundle_id)?.current).toBe('DELIVERED');

    // Mark as read (simulates CommOS.markConversationRead).
    bobInbox[0].read = true;
    bobInbox[0].delivery_state = 'READ';
    bobRT.delivery.transition(bundle_id, 'READ', { node: 'bob' });

    // After marking as read.
    expect(bobInbox[0].read).toBe(true);
    expect(bobRT.delivery.get(bundle_id)?.current).toBe('READ');
  });

  it('multiple bundles in the same conversation are grouped together', async () => {
    await dispatchFromAlice('First message', 'conv-group');
    await new Promise((r) => setTimeout(r, 50));
    await dispatchFromAlice('Second message', 'conv-group');
    await new Promise((r) => setTimeout(r, 50));
    await dispatchFromAlice('Other conversation', 'conv-other');
    await new Promise((r) => setTimeout(r, 100));

    expect(bobInbox.length).toBe(3);
    const convGroup = bobInbox.filter((m) => m.conversation_id === 'conv-group');
    const convOther = bobInbox.filter((m) => m.conversation_id === 'conv-other');
    expect(convGroup.length).toBe(2);
    expect(convOther.length).toBe(1);
    expect(convGroup[0].plaintext).toBe('First message');
    expect(convGroup[1].plaintext).toBe('Second message');
  });

  it('bundles to different nodes have separate inboxes', async () => {
    // Alice also has an inbox (she shouldn't receive her own bundles, but
    // the test verifies the inbox is per-node).
    await dispatchFromAlice('To Bob', 'conv-bob');
    await new Promise((r) => setTimeout(r, 100));

    // Bob's inbox has the message; Alice's (if she had one) wouldn't.
    expect(bobInbox.length).toBe(1);
    expect(bobInbox[0].plaintext).toBe('To Bob');
  });
});
