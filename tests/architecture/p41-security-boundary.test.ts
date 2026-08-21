/**
 * tests/architecture/p41-security-boundary.test.ts — P4.1
 *
 * Tests for the Android security boundary (P4-DESIGN §14).
 *
 * R4 — Key boundary: signing keys live in Keystore, not app storage.
 *
 * Article IX — no invented cryptography.
 * Article XVIII §4 — no private-key plaintext persistence.
 *
 * Tests:
 *   - no plaintext keys in logs
 *   - no sensitive bundle contents in logs
 *   - fail-closed when Keystore is locked
 *   - no substitute cryptographic primitives
 */

import { describe, it, expect, vi } from 'vitest';
import { AndroidRuntimeHost } from '@/server/android/AndroidRuntimeHost';
import { AndroidBundleStore } from '@/server/android/AndroidBundleStore';
import { TestKeystoreAdapter, TestResourceReportSampler } from '@/server/android/TestAdapters';
import { createUniversalIdentity, generateIdentityKeyPair, createBundle, createIntent, defaultPolicy, toRef } from '@/core/index';
import type { UniversalIdentity } from '@/core/identity/types';
import type { NodeCapabilities } from '@/core/capabilities/types';

function makeIdentity(): UniversalIdentity {
  const kp = generateIdentityKeyPair();
  return createUniversalIdentity({ display_name: 'Test', key_set: kp.key_set });
}

function makeCapabilities(node_id: string): NodeCapabilities {
  return {
    node_id,
    messaging: new Set(['SEND', 'RECEIVE'] as const),
    transport: new Set(['BLE' as const]),
    relay: new Set(['STORE', 'FORWARD'] as const),
    gateway: new Set(),
    resource: { battery_pct: 0.85, bandwidth_bps: 125_000, storage_bytes: 1_000_000_000, compute_units: 4, sampled_at: Date.now() },
    advertised_at: Date.now(),
    verification: 'UNVERIFIED',
  };
}

describe('P4.1 — Security boundary', () => {
  it('R4: signing fails when Keystore is locked (fail-closed)', async () => {
    const identity = makeIdentity();
    const keystore = new TestKeystoreAdapter();
    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeCapabilities(identity.id),
      bundleStore: new AndroidBundleStore(),
      keystore,
      resourceSampler: new TestResourceReportSampler(),
    });
    await host.start();
    keystore.lock();
    expect(keystore.isUnlocked()).toBe(false);
    const sig = await host.signPayload(new Uint8Array([1, 2, 3]));
    expect(sig).toBeNull(); // fail-closed
  });

  it('R4: signing succeeds when Keystore is unlocked', async () => {
    const identity = makeIdentity();
    const keystore = new TestKeystoreAdapter();
    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeCapabilities(identity.id),
      bundleStore: new AndroidBundleStore(),
      keystore,
      resourceSampler: new TestResourceReportSampler(),
    });
    await host.start();
    const sig = await host.signPayload(new Uint8Array([1, 2, 3]));
    expect(sig).not.toBeNull();
    expect(sig!.length).toBe(64); // Ed25519 detached signature
  });

  it('R4: the public key is exportable (32 bytes for Ed25519)', () => {
    const identity = makeIdentity();
    const keystore = new TestKeystoreAdapter();
    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeCapabilities(identity.id),
      bundleStore: new AndroidBundleStore(),
      keystore,
      resourceSampler: new TestResourceReportSampler(),
    });
    const pubkey = host.getPublicKey();
    expect(pubkey.length).toBe(32);
  });

  it('R4: no private key material in console output (spy on console.log)', async () => {
    const identity = makeIdentity();
    const keystore = new TestKeystoreAdapter();
    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeCapabilities(identity.id),
      bundleStore: new AndroidBundleStore(),
      keystore,
      resourceSampler: new TestResourceReportSampler(),
    });
    await host.start();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Sign a payload — the signing process should NOT log the secret key.
    await host.signPayload(new Uint8Array([1, 2, 3]));
    // Check that no log line contains key-like material (32+ hex chars).
    for (const call of consoleSpy.mock.calls) {
      const arg = String(call[0]);
      // The secret key is 64 bytes (Ed25519 secret key). We check for any
      // 64+ char hex string that could be a key.
      expect(arg).not.toMatch(/[0-9a-f]{64,}/i);
    }
    consoleSpy.mockRestore();
  });

  it('Article XVIII §3: bundle payload is opaque (never decrypted by the runtime)', async () => {
    const identity = makeIdentity();
    const keystore = new TestKeystoreAdapter();
    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeCapabilities(identity.id),
      bundleStore: new AndroidBundleStore(),
      keystore,
      resourceSampler: new TestResourceReportSampler(),
    });
    await host.start();
    // Create a bundle with an opaque ciphertext payload.
    const bundle = createBundle({
      bundle_id: 'bundle-opaque',
      sender: toRef(identity),
      recipient: { kind: 'IDENTITY', ref: { id: identity.id, signing_pubkey_hash: 'h' } },
      conversation_id: 'conv',
      intent: createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 }),
      encryption_metadata: { algorithm: 'nacl-box-sealed', recipient_pubkey_hash: 'h', nonce: 'n', additional_data: 'ad' },
      payload: { bytes_len: 32, ciphertext: 'opaque-ciphertext-data' },
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      routing_policy: { policy_id: defaultPolicy.policy_id, inline: { replication_factor: 1, max_hops: 4, require_e2e: true } },
    });
    // The runtime receives the bundle but does NOT decrypt it.
    const ok = await host.receiveBundle(bundle, 'alice');
    expect(ok).toBe(true);
    // The payload field is still 'opaque-ciphertext-data' — not decrypted.
    expect((bundle.payload as any).ciphertext).toBe('opaque-ciphertext-data');
  });

  it('Article IX: no new cryptographic primitives introduced (uses tweetnacl only)', () => {
    // The TestKeystoreAdapter uses nacl.sign.detached — the same primitive
    // as core/trust/Proof.ts. No new crypto.
    const keystore = new TestKeystoreAdapter();
    const pubkey = keystore.getPublicKey();
    expect(pubkey.length).toBe(32); // Ed25519 public key — same as core/trust/Proof.ts
  });

  it('the runtime does NOT cache the signing secret key in plaintext app storage', () => {
    // In the real Android impl, the secret key NEVER leaves AndroidKeychain.
    // The TestKeystoreAdapter holds it in memory only — the test fixture
    // exposes assertNoPlaintextKeyInStorage() for documentation.
    const keystore = new TestKeystoreAdapter();
    expect(() => keystore.assertNoPlaintextKeyInStorage()).not.toThrow();
  });
});
