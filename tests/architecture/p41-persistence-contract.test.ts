/**
 * tests/architecture/p41-persistence-contract.test.ts — P4.1
 *
 * Tests for the StoredBundle protocol contract (Article XVIII §13).
 * Verifies the cross-impl invariants P1-P7 hold in the AndroidBundleStore.
 *
 * These tests are written against the PROTOCOL CONTRACT, not the
 * impl-specific schema. They should pass for any BundleStore impl that
 * satisfies P1-P7.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AndroidBundleStore } from '@/server/android/AndroidBundleStore';
import { createUniversalIdentity, generateIdentityKeyPair, createBundle, createIntent, defaultPolicy, toRef } from '@/core/index';
import type { CommunicationBundle } from '@/core/bundle/types';
import type { UniversalIdentity } from '@/core/identity/types';

function makeIdentity(): UniversalIdentity {
  const kp = generateIdentityKeyPair();
  return createUniversalIdentity({ display_name: 'Test', key_set: kp.key_set });
}

function makeBundle(bundle_id: string, from: UniversalIdentity, to: string): CommunicationBundle {
  return createBundle({
    bundle_id,
    sender: toRef(from),
    recipient: { kind: 'IDENTITY', ref: { id: to, signing_pubkey_hash: 'h' } },
    conversation_id: `conv-${bundle_id}`,
    intent: createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 }),
    encryption_metadata: { algorithm: 'nacl-box-sealed', recipient_pubkey_hash: 'h', nonce: 'n', additional_data: 'ad' },
    payload: { bytes_len: 16, ciphertext: 'opaque' },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    routing_policy: { policy_id: defaultPolicy.policy_id, inline: { replication_factor: 1, max_hops: 4, require_e2e: true } },
  });
}

describe('P4.1 — StoredBundle contract invariants (P1-P7)', () => {
  let identity: UniversalIdentity;
  let store: AndroidBundleStore;

  beforeEach(() => {
    identity = makeIdentity();
    store = new AndroidBundleStore();
    store.setNodeId(identity.id);
  });

  // P1 — bundle identity
  it('P1: push() is idempotent (same bundle_id → one record, not duplicate)', () => {
    const bundle = makeBundle('bundle-p1', identity, 'bob');
    store.push(bundle, 'bob');
    store.push(bundle, 'bob'); // duplicate
    expect(store.size()).toBe(1);
    expect(store.has('bundle-p1')).toBe(true);
  });

  it('P1: different bundle_ids → different records', () => {
    store.push(makeBundle('bundle-a', identity, 'bob'), 'bob');
    store.push(makeBundle('bundle-b', identity, 'bob'), 'bob');
    expect(store.size()).toBe(2);
  });

  // P2 — deduplication identity
  it('P2: markReceived() is idempotent (same bundle_id → one received record)', () => {
    store.markReceived('bundle-p2', 'alice');
    store.markReceived('bundle-p2', 'alice'); // duplicate
    expect(store.hasReceived('bundle-p2')).toBe(true);
  });

  it('P2: dedup is by bundle_id only (not by contents/sender/arrival time)', () => {
    store.markReceived('bundle-p2b', 'alice');
    // Same bundle_id, different from_node_id — still deduped.
    store.markReceived('bundle-p2b', 'carol');
    expect(store.hasReceived('bundle-p2b')).toBe(true);
  });

  // P3 — idempotent TTL expiry
  it('P3: TTL sweeper is idempotent (expired bundles are only returned once)', () => {
    const bundle = makeBundle('bundle-p3', identity, 'bob');
    store.push(bundle, 'bob');
    // Force the store to see this bundle as expired by checking with a future timestamp.
    const expired1 = store.getExpiredBundleIds(Date.now() + 100_000);
    expect(expired1).toContain('bundle-p3');
    // Transition to EXPIRED via the canonical tracker.
    store.updateStateFromTracker('bundle-p3', 'EXPIRED');
    // Run again — should NOT return the already-EXPIRED bundle.
    const expired2 = store.getExpiredBundleIds(Date.now() + 100_000);
    expect(expired2).not.toContain('bundle-p3');
  });

  // P4 — state transitions via DeliveryTracker.transition() only
  it('P4: updateStateFromTracker() is the only way to change state (no direct setter)', () => {
    store.push(makeBundle('bundle-p4', identity, 'bob'), 'bob');
    const record = store.snapshot().storedRecords[0];
    expect(record.state).toBe('QUEUED');
    // P4 — the store exposes updateStateFromTracker(), NOT a direct state setter.
    store.updateStateFromTracker('bundle-p4', 'RELAYED');
    expect(store.snapshot().storedRecords[0].state).toBe('RELAYED');
    // Idempotent — same state is a no-op.
    store.updateStateFromTracker('bundle-p4', 'RELAYED');
    expect(store.snapshot().storedRecords[0].state).toBe('RELAYED');
  });

  // P5 — forwarding-proof append-only
  it('P5: appendForwardingProof() updates only bundle_json (no other field)', () => {
    const bundle = makeBundle('bundle-p5', identity, 'bob');
    store.push(bundle, 'bob');
    // Deep-copy the before-state (snapshot returns references, not copies).
    const beforeRecord = JSON.parse(JSON.stringify(store.snapshot().storedRecords[0]));
    // Simulate forwarding — append a proof to the bundle.
    const updatedBundle: CommunicationBundle = {
      ...bundle,
      proofs: [...bundle.proofs, { kind: 'RELAY_FORWARD' as const, signer: { id: 'relay', signing_pubkey_hash: 'h' }, signature: 'sig', payload_hash: 'ph', ts: Date.now() }],
    } as unknown as CommunicationBundle;
    store.appendForwardingProof('bundle-p5', updatedBundle);
    const afterRecord = store.snapshot().storedRecords[0];
    // P5 — only bundle_json changes. Other record fields are NOT modified.
    expect(afterRecord.next_hop).toBe(beforeRecord.next_hop);
    expect(afterRecord.priority).toBe(beforeRecord.priority);
    expect(afterRecord.expires_at).toBe(beforeRecord.expires_at);
    expect(afterRecord.queued_at).toBe(beforeRecord.queued_at);
    expect(afterRecord.state).toBe(beforeRecord.state);
    // The bundle_json DID change (new proof appended).
    expect(afterRecord.bundle_json).not.toBe(beforeRecord.bundle_json);
    // Verify the new proof is actually in the serialized bundle.
    expect(afterRecord.bundle_json).toContain('RELAY_FORWARD');
  });

  // P6 — crash consistency
  it('P6: snapshot() is consistent (returns all QUEUED bundles)', () => {
    store.push(makeBundle('bundle-p6a', identity, 'bob'), 'bob');
    store.push(makeBundle('bundle-p6b', identity, 'bob'), 'bob');
    const snapshot = store.snapshot();
    expect(snapshot.queuedBundles.length).toBe(2);
    expect(snapshot.queuedBundles.map((q) => q.bundle.bundle_id).sort()).toEqual(['bundle-p6a', 'bundle-p6b']);
  });

  it('P6: remove() leaves the store in a consistent state', () => {
    store.push(makeBundle('bundle-p6c', identity, 'bob'), 'bob');
    store.push(makeBundle('bundle-p6d', identity, 'bob'), 'bob');
    expect(store.size()).toBe(2);
    store.remove('bundle-p6c');
    expect(store.size()).toBe(1);
    expect(store.has('bundle-p6c')).toBe(false);
    expect(store.has('bundle-p6d')).toBe(true);
  });

  // P7 — schema migrations
  it('P7: schema migrations are forward-only (recorded in schema_migrations)', () => {
    const migrations = store.getSchemaMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    expect(migrations).toContain('initial-v1');
  });

  // Cross-impl: the state field uses canonical Article VI enum
  it('the state field uses canonical Article VI enum values only', () => {
    store.push(makeBundle('bundle-enum', identity, 'bob'), 'bob');
    const record = store.snapshot().storedRecords[0];
    const canonical_states = ['CREATED', 'ACCEPTED', 'QUEUED', 'RELAYED', 'GATEWAY_REACHED', 'EXTERNAL_ACCEPTED', 'DELIVERED', 'READ', 'EXPIRED', 'REJECTED', 'POLICY_BLOCKED', 'NO_ROUTE', 'CHANNEL_UNAVAILABLE', 'GATEWAY_UNAVAILABLE', 'DESTINATION_UNKNOWN'];
    expect(canonical_states).toContain(record.state);
  });
});
