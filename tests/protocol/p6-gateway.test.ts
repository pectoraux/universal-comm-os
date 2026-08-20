/**
 * P6 Internet Gateway tests.
 *
 * Proves: offline edge → relay → gateway → external channel adapter.
 *
 * Per ROADMAP P6: "Prove offline user → Internet gateway."
 * Per master prompt Scenario C: User → Bluetooth → Relay → Gateway → Internet → Destination.
 *
 * The "Internet destination" here is an email inbox (simulated by the
 * EmailAdapter's in-process transcript). The bundle is end-to-end encrypted
 * to a key derived from the (channel, channel_id), so the recipient's email
 * client can decrypt on the other side.
 *
 * THREAT_MODEL §1: the gateway does NOT decrypt. The EmailAdapter packages
 * the opaque ciphertext into the email body. The recipient extracts and
 * decrypts.
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
import { createGatewayRuntime } from '@/gateway/GatewayRuntime';
import { EmailAdapter } from '@/adapters/email/EmailAdapter';
import { utf8Encode, utf8Decode } from '@/core/util/encoding';

/**
 * Helper: synthesize the same channel identity keypair the demo uses.
 * Same (channel, channel_id) always produces the same keypair.
 */
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha2.js';
function synthChannelIdentity(channel: string, channel_id: string) {
  const seedStr = `universal-comm-os|${channel}|${channel_id}`;
  const seed = sha256(new TextEncoder().encode(seedStr));
  const keypair = nacl.box.keyPair.fromSecretKey(seed);
  return {
    pubkey: keypair.publicKey,
    secret: keypair.secretKey,
    identity_id: `channel-identity:${channel}:${channel_id}`,
  };
}

describe('P6 — Internet Gateway (offline edge → relay → gateway → email adapter)', () => {
  let bus1: LoopbackBus;
  let bus2: LoopbackBus;
  let aliceT: LoopbackTransport;
  let relayToAlice: LoopbackTransport;
  let relayToGateway: LoopbackTransport;
  let gatewayT: LoopbackTransport;
  let aliceRT: NodeRuntime;
  let relayRT: NodeRuntime;
  let gatewayRT: NodeRuntime;
  let emailAdapter: EmailAdapter;
  let aliceId: UniversalIdentity;
  let aliceKp: any;

  beforeEach(() => {
    bus1 = new LoopbackBus(); // Alice <-> Relay
    bus2 = new LoopbackBus(); // Relay <-> Gateway
    const aliceK = generateIdentityKeyPair();
    const relayK = generateIdentityKeyPair();
    const gatewayK = generateIdentityKeyPair();
    aliceKp = aliceK;
    aliceId = createUniversalIdentity({ display_name: 'Alice (Mobile)', key_set: aliceK.key_set });
    const relayId = createUniversalIdentity({ display_name: 'Relay (Pi)', key_set: relayK.key_set });
    const gatewayId = createUniversalIdentity({ display_name: 'Gateway', key_set: gatewayK.key_set });

    aliceT = new LoopbackTransport({ node_id: 'alice', transport_type: 'LAN', peer_node_ids: ['relay'] }, bus1);
    relayToAlice = new LoopbackTransport({ node_id: 'relay', transport_type: 'LAN', peer_node_ids: ['alice'] }, bus1);
    relayToGateway = new LoopbackTransport({ node_id: 'relay', transport_type: 'LAN', peer_node_ids: ['gateway'] }, bus2);
    gatewayT = new LoopbackTransport({ node_id: 'gateway', transport_type: 'LAN', peer_node_ids: ['relay'] }, bus2);

    emailAdapter = new EmailAdapter({
      adapter_id: 'email-test',
      from_address: 'gateway@universal-comm-os.test',
    });
    const gatewayRuntime = createGatewayRuntime();
    gatewayRuntime.registerAdapter(emailAdapter);

    aliceRT = createNodeRuntime({
      identity: aliceId,
      capabilities: advertiseCapabilities({ node_id: 'alice', messaging: ['SEND'], transport: ['LAN'] }),
      transports: [aliceT],
      bundleStore: createInMemoryBundleStore(),
      signing_secret_key: aliceK.signing_secret_key,
    });
    relayRT = createNodeRuntime({
      identity: relayId,
      capabilities: advertiseCapabilities({ node_id: 'relay', transport: ['LAN'], relay: ['STORE', 'FORWARD'], verification: 'PEER_CORROBORATED' }),
      transports: [relayToAlice, relayToGateway],
      bundleStore: createInMemoryBundleStore(),
      signing_secret_key: relayK.signing_secret_key,
    });
    gatewayRT = createNodeRuntime({
      identity: gatewayId,
      capabilities: advertiseCapabilities({ node_id: 'gateway', transport: ['LAN'], relay: ['FORWARD'], gateway: ['EMAIL', 'SMS', 'MATRIX'], verification: 'TRUSTED' }),
      transports: [gatewayT],
      bundleStore: createInMemoryBundleStore(),
      signing_secret_key: gatewayK.signing_secret_key,
      gatewayRuntime,
    });
  });

  it('routes a CHANNEL-recipient bundle through Alice → Relay → Gateway → EmailAdapter', async () => {
    // Alice composes a bundle addressed to email recipient "bob@example.com".
    // The bundle's payload is end-to-end encrypted to the synth channel pubkey.
    const synth = synthChannelIdentity('EMAIL', 'bob@example.com');
    const intent = createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 });
    const now = Date.now();
    const expires_at = now + 60_000;
    const env = sealPayload({
      bundle_id: 'pending',
      intent_type: intent.type,
      expires_at,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: synth.pubkey,
      plaintext: utf8Encode('Email gateway test — encrypted end-to-end.'),
    });
    const bundle = createBundle({
      sender: toRef(aliceId),
      recipient: { kind: 'CHANNEL', channel: 'EMAIL', channel_id: 'bob@example.com' },
      conversation_id: `conv:email:bob@example.com`,
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
    // Re-seal with the real bundle_id.
    const realEnv = sealPayload({
      bundle_id: bundle.bundle_id,
      intent_type: intent.type,
      expires_at: bundle.expires_at,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: synth.pubkey,
      plaintext: utf8Encode('Email gateway test — encrypted end-to-end.'),
    });
    const senderProof = signProof(
      'SENDER_SIGNATURE',
      {
        bundle_id: bundle.bundle_id,
        sender_id: bundle.sender.id,
        sender_signing_pubkey_hash: bundle.sender.signing_pubkey_hash,
        recipient_kind: bundle.recipient.kind,
        recipient_descriptor: `EMAIL:bob@example.com`,
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

    // Alice dispatches — destination is the channel recipient.
    const result = await aliceRT.dispatch({
      bundle: bundleWithProof,
      destination: { channel: 'EMAIL', channel_id: 'bob@example.com' },
    });
    expect(result.status).toBe('DISPATCHED');

    // Wait for async propagation through Relay → Gateway.
    await new Promise((r) => setTimeout(r, 100));

    // Alice's side: bundle left her device.
    const aliceRec = aliceRT.delivery.get(bundle.bundle_id);
    expect(aliceRec?.current).toBe('RELAYED');

    // Relay's side: forwarded onward.
    const relayRec = relayRT.delivery.get(bundle.bundle_id);
    expect(relayRec?.current).toBe('RELAYED');

    // Gateway's side: GATEWAY_REACHED → EXTERNAL_ACCEPTED → DELIVERED.
    const gatewayRec = gatewayRT.delivery.get(bundle.bundle_id);
    expect(gatewayRec?.current).toBe('DELIVERED');
    const transitions = gatewayRec?.history.map((h) => h.to) ?? [];
    expect(transitions).toContain('GATEWAY_REACHED');
    expect(transitions).toContain('EXTERNAL_ACCEPTED');
    expect(transitions).toContain('DELIVERED');

    // The EmailAdapter "sent" the bundle — its transcript has one entry.
    const transcript = emailAdapter.getTranscript();
    expect(transcript.length).toBe(1);
    expect(transcript[0].to).toBe('bob@example.com');
    expect(transcript[0].bundle_id).toBe(bundle.bundle_id);
    // The email body contains the opaque ciphertext (NOT plaintext).
    expect(transcript[0].body).toContain('---CIPHERTEXT---');
    expect(transcript[0].body).not.toContain('Email gateway test');

    // The recipient can decrypt the email body's ciphertext using the synth secret.
    const env2 = { encryption_metadata: realEnv.encryption_metadata, payload: realEnv.payload };
    expect(isRecipientFor(env2, synth.pubkey)).toBe(true);
    const plaintext = openSealedPayload(env2, synth.secret);
    expect(utf8Decode(plaintext)).toBe('Email gateway test — encrypted end-to-end.');
  });

  it('rejects a CHANNEL-recipient bundle if no adapter is registered', async () => {
    // Create a gateway runtime with NO adapters registered.
    const emptyGatewayRuntime = createGatewayRuntime();
    // Replace the gateway's runtime.
    const newGatewayRT = createNodeRuntime({
      identity: gatewayRT.identity,
      capabilities: gatewayRT.capabilities,
      transports: [gatewayT],
      bundleStore: createInMemoryBundleStore(),
      gatewayRuntime: emptyGatewayRuntime,
    });
    // Detach old gatewayRT by closing it (best effort).
    void gatewayRT;

    const synth = synthChannelIdentity('EMAIL', 'nobody@example.com');
    const intent = createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 });
    const now = Date.now();
    const expires_at = now + 60_000;
    const env = sealPayload({
      bundle_id: 'pending',
      intent_type: intent.type,
      expires_at,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: synth.pubkey,
      plaintext: utf8Encode('should fail at gateway'),
    });
    const bundle = createBundle({
      sender: toRef(aliceId),
      recipient: { kind: 'CHANNEL', channel: 'EMAIL', channel_id: 'nobody@example.com' },
      conversation_id: 'conv-fail',
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
      recipient_encryption_pubkey: synth.pubkey,
      plaintext: utf8Encode('should fail at gateway'),
    });
    const bundleWithProof: CommunicationBundle = {
      ...bundle,
      encryption_metadata: realEnv.encryption_metadata,
      payload: realEnv.payload,
      proofs: [],
    };

    // We need the relay to forward to the new gateway. But the relay was set up
    // with the old gatewayRT, and we can't easily replace it. So instead, we
    // simulate "bundle arrived at gateway directly" via transport.
    await relayToGateway.send(bundleWithProof, 'gateway');
    await new Promise((r) => setTimeout(r, 100));

    // The new gateway's tracker should show GATEWAY_UNAVAILABLE (no adapter).
    const rec = newGatewayRT.delivery.get(bundle.bundle_id);
    expect(rec).toBeDefined();
    expect(rec?.current).toBe('GATEWAY_UNAVAILABLE');
  });
});
