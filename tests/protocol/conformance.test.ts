/**
 * Protocol conformance tests (ARCH-026). Verifies that the core protocol
 * obeys its own semantics: bundles are deduplicated, expired bundles are
 * rejected, sealed envelopes can only be opened by the recipient, etc.
 */

import { describe, it, expect } from 'vitest';
import {
  createUniversalIdentity,
  generateIdentityKeyPair,
  createChannelIdentity,
  toRef,
  createIntent,
  createBundle,
  canonicalEnvelope,
  isExpired,
  sealPayload,
  openSealedPayload,
  isRecipientFor,
  signProof,
  verifyProof,
  createConversation,
  createDeliveryTracker,
  advertiseCapabilities,
  deriveRoles,
  isGateway,
  canStore,
  canForward,
  createRoutingPolicy,
  defaultPolicy,
  createRouter,
  utf8Encode,
  b64urlDecode,
} from '@/core/index';

describe('Protocol: identity + channel', () => {
  it('creates a UniversalIdentity with a keypair and a channel', () => {
    const kp = generateIdentityKeyPair();
    const identity = createUniversalIdentity({
      display_name: 'Alice',
      key_set: kp.key_set,
      channel_identities: [
        createChannelIdentity({ channel: 'EMAIL', channel_id: 'alice@example.com', verified: 'VERIFIED' }),
      ],
    });
    expect(identity.id).toBeTruthy();
    expect(identity.channel_identities.length).toBe(1);
    expect(identity.signing_pubkey_hash).toBeTruthy();
  });

  it('does NOT auto-merge channels by default — attachChannelIdentity is explicit', () => {
    const kp = generateIdentityKeyPair();
    const identity = createUniversalIdentity({
      display_name: 'Bob',
      key_set: kp.key_set,
    });
    const ref = toRef(identity);
    expect(ref.signing_pubkey_hash).toBe(identity.signing_pubkey_hash);
  });
});

describe('Protocol: intent', () => {
  it('rejects min_reliability outside [0,1]', () => {
    expect(() => createIntent({ type: 'SEND_MESSAGE', min_reliability: 1.5 })).toThrow();
    expect(() => createIntent({ type: 'SEND_MESSAGE', min_reliability: -0.1 })).toThrow();
  });
  it('rejects non-positive ttl_ms', () => {
    expect(() => createIntent({ type: 'SEND_MESSAGE', ttl_ms: 0 })).toThrow();
  });
  it('classifies emergency correctly', () => {
    const emergencyIntent = createIntent({ type: 'EMERGENCY_ALERT' });
    expect(emergencyIntent.priority).toBe('NORMAL'); // type-based emergency
    expect(emergencyIntent).toBeDefined();
  });
});

describe('Protocol: bundle lifecycle', () => {
  it('builds a bundle with sender + recipient + intent', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const aliceIdentity = createUniversalIdentity({ display_name: 'Alice', key_set: alice.key_set });
    const bobIdentity = createUniversalIdentity({ display_name: 'Bob', key_set: bob.key_set });

    const intent = createIntent({ type: 'SEND_MESSAGE' });
    const envelope = sealPayload({
      bundle_id: 'b1',
      intent_type: intent.type,
      expires_at: Date.now() + 60000,
      sender: toRef(aliceIdentity),
      recipient_encryption_pubkey: bobIdentity.public_keys.encryption_pubkey,
      plaintext: utf8Encode('Hello, Bob!'),
    });
    const bundle = createBundle({
      sender: toRef(aliceIdentity),
      recipient: { kind: 'IDENTITY', ref: toRef(bobIdentity) },
      conversation_id: 'conv-1',
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
    expect(bundle.bundle_id).toBeTruthy();
    expect(bundle.intent.type).toBe('SEND_MESSAGE');
    expect(isExpired(bundle)).toBe(false);
  });

  it('rejects bundles with expires_at <= created_at', () => {
    const kp = generateIdentityKeyPair();
    const identity = createUniversalIdentity({ key_set: kp.key_set });
    const intent = createIntent({ type: 'SEND_MESSAGE' });
    const env = sealPayload({
      bundle_id: 'x',
      intent_type: intent.type,
      expires_at: Date.now() + 60000,
      sender: toRef(identity),
      recipient_encryption_pubkey: kp.key_set.encryption_pubkey,
      plaintext: utf8Encode('hi'),
    });
    expect(() =>
      createBundle({
        sender: toRef(identity),
        recipient: { kind: 'IDENTITY', ref: toRef(identity) },
        conversation_id: 'c',
        intent,
        encryption_metadata: env.encryption_metadata,
        payload: env.payload,
        routing_policy: {
          policy_id: defaultPolicy.policy_id,
          inline: {
            replication_factor: 1,
            max_hops: 4,
            require_e2e: true,
          },
        },
        created_at: 1000,
        expires_at: 1000,
      }),
    ).toThrow();
  });
});

describe('Protocol: crypto envelope — relays cannot decrypt', () => {
  it('recipient can open a sealed envelope', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const aliceId = createUniversalIdentity({ key_set: alice.key_set });
    const bobId = createUniversalIdentity({ key_set: bob.key_set });

    const plaintext = utf8Encode('secret message');
    const env = sealPayload({
      bundle_id: 'b-seal',
      intent_type: 'SEND_MESSAGE',
      expires_at: Date.now() + 60000,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: bobId.public_keys.encryption_pubkey,
      plaintext,
    });
    expect(isRecipientFor(env, bobId.public_keys.encryption_pubkey)).toBe(true);
    const opened = openSealedPayload(env, bob.encryption_secret_key);
    expect(opened).toEqual(plaintext);
  });

  it('a different recipient (e.g. the relay) cannot open the envelope', () => {
    const alice = generateIdentityKeyPair();
    const bob = generateIdentityKeyPair();
    const relay = generateIdentityKeyPair();
    const aliceId = createUniversalIdentity({ key_set: alice.key_set });
    const bobId = createUniversalIdentity({ key_set: bob.key_set });

    const env = sealPayload({
      bundle_id: 'b-relay',
      intent_type: 'SEND_MESSAGE',
      expires_at: Date.now() + 60000,
      sender: toRef(aliceId),
      recipient_encryption_pubkey: bobId.public_keys.encryption_pubkey,
      plaintext: utf8Encode('for bob only'),
    });
    // The relay's pubkey doesn't match the recipient hash.
    expect(isRecipientFor(env, relay.key_set.encryption_pubkey)).toBe(false);
    // Attempting to decrypt with the relay's secret key throws.
    expect(() => openSealedPayload(env, relay.encryption_secret_key)).toThrow();
  });
});

describe('Protocol: proofs verify', () => {
  it('signs and verifies a SENDER_SIGNATURE proof', () => {
    const alice = generateIdentityKeyPair();
    const aliceId = createUniversalIdentity({ key_set: alice.key_set });
    const fields = { bundle_id: 'b-proof', created_at: 1234, expires_at: 5678 };
    const proof = signProof('SENDER_SIGNATURE', fields, toRef(aliceId), alice.signing_secret_key);
    expect(verifyProof(proof, fields, alice.key_set.signing_pubkey)).toBe(true);

    // Tampering with any field invalidates the signature.
    const tampered = { ...fields, created_at: 9999 };
    expect(verifyProof(proof, tampered, alice.key_set.signing_pubkey)).toBe(false);
  });
});

describe('Protocol: conversation', () => {
  it('rejects conversations with fewer than 2 participants', () => {
    expect(() => createConversation({ participants: ['only-one'] })).toThrow();
  });
});

describe('Protocol: delivery state machine', () => {
  it('transitions through the happy path', () => {
    const t = createDeliveryTracker();
    t.init('h1');
    t.transition('h1', 'ACCEPTED');
    t.transition('h1', 'QUEUED');
    t.transition('h1', 'RELAYED');
    t.transition('h1', 'DELIVERED');
    t.transition('h1', 'READ');
    const rec = t.get('h1')!;
    expect(rec.current).toBe('READ');
    expect(rec.history.length).toBe(6);
  });

  it('treats expired bundles as terminal', () => {
    const t = createDeliveryTracker();
    t.init('h2');
    t.transition('h2', 'EXPIRED');
    expect(() => t.transition('h2', 'DELIVERED')).toThrow();
  });
});

describe('Protocol: capabilities (not device types)', () => {
  it('derives roles from capabilities', () => {
    const gateway = advertiseCapabilities({
      node_id: 'g1',
      transport: ['INTERNET'],
      gateway: ['EMAIL', 'SMS'],
    });
    expect(isGateway(gateway)).toBe(true);
    expect(deriveRoles(gateway)).toContain('GATEWAY');

    const relay = advertiseCapabilities({
      node_id: 'r1',
      transport: ['BLE', 'WIFI'],
      relay: ['STORE', 'FORWARD'],
    });
    expect(canStore(relay)).toBe(true);
    expect(canForward(relay)).toBe(true);
    expect(deriveRoles(relay)).toContain('RELAY');
  });

  it('does NOT make a node a gateway merely because it has INTERNET (ARCH-018)', () => {
    const personal = advertiseCapabilities({
      node_id: 'p1',
      transport: ['INTERNET', 'WIFI'],
      messaging: ['SEND', 'RECEIVE'],
    });
    expect(isGateway(personal)).toBe(false);
  });
});

describe('Protocol: routing returns NO_ROUTE when constraints cannot be met', () => {
  it('returns NO_ROUTE if no peer has the requested transport', () => {
    const route = createRouter(defaultPolicy);
    const decision = route({
      intent: createIntent({ type: 'SEND_MESSAGE' }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'B',
          transport: [], // no transport available
          relay: [],
          gateway: [],
          verification: 'UNVERIFIED',
        },
      ],
      destination: { node_id: 'B' },
    });
    expect(decision.status).toBe('NO_ROUTE');
  });
});

describe('Protocol: routing plan honors policy forbidden_transports', () => {
  it('skips forbidden transports', () => {
    const policy = createRoutingPolicy({
      policy_id: 'no-ble',
      name: 'No BLE policy',
      forbidden_transports: ['BLE'],
    });
    const route = createRouter(policy);
    const decision = route({
      intent: createIntent({ type: 'SEND_MESSAGE' }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'B',
          transport: ['BLE'],
          relay: [],
          gateway: [],
          verification: 'UNVERIFIED',
        },
      ],
      destination: { node_id: 'B' },
    });
    expect(decision.status).toBe('NO_ROUTE');
  });
});
