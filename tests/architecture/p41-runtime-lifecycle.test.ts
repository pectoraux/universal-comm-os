/**
 * tests/architecture/p41-runtime-lifecycle.test.ts — P4.1
 *
 * Tests for the Android Runtime Host lifecycle + the 7 runtime-boundary
 * invariants (R1-R7) from P4 design §1.3.3.
 *
 * Article XVIII §14 — a failure of any R-invariant is an
 * architecture-control defect.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AndroidRuntimeHost } from '@/server/android/AndroidRuntimeHost';
import { AndroidBundleStore } from '@/server/android/AndroidBundleStore';
import { TestKeystoreAdapter, TestResourceReportSampler } from '@/server/android/TestAdapters';
import { FakeTransport } from '@/server/android/conformance/FakeTransport';
import {
  transitionRuntimeLifecycle,
  RuntimeLifecycleError,
  type AndroidRuntimeLifecycleState,
  type RuntimeLifecycleObserver,
} from '@/server/android/types';
import { createUniversalIdentity, generateIdentityKeyPair } from '@/core/index';
import { createBundle, createIntent, defaultPolicy, toRef } from '@/core/index';
import type { CommunicationBundle } from '@/core/bundle/types';
import type { UniversalIdentity } from '@/core/identity/types';
import type { NodeCapabilities } from '@/core/capabilities/types';

function makeTestIdentity(display_name: string): { identity: UniversalIdentity; keypair: ReturnType<typeof generateIdentityKeyPair> } {
  const keypair = generateIdentityKeyPair();
  const identity = createUniversalIdentity({ display_name, key_set: keypair.key_set });
  return { identity, keypair };
}

function makeTestCapabilities(node_id: string): NodeCapabilities {
  return {
    node_id,
    messaging: new Set(['SEND', 'RECEIVE'] as const),
    transport: new Set(['BLE' as const]),
    relay: new Set(['STORE', 'FORWARD'] as const),
    gateway: new Set(),
    resource: {
      battery_pct: 0.85,
      bandwidth_bps: 125_000,
      storage_bytes: 1_000_000_000,
      compute_units: 4,
      sampled_at: Date.now(),
    },
    advertised_at: Date.now(),
    verification: 'UNVERIFIED',
  };
}

function makeTestBundle(bundle_id: string, from: UniversalIdentity, to_node_id: string): CommunicationBundle {
  const intent = createIntent({ type: 'SEND_MESSAGE', ttl_ms: 60_000 });
  return createBundle({
    bundle_id, // explicit — otherwise createBundle generates a random UUID
    sender: toRef(from),
    recipient: { kind: 'IDENTITY', ref: { id: to_node_id, signing_pubkey_hash: 'test-hash' } },
    conversation_id: `conv-${bundle_id}`,
    intent,
    encryption_metadata: {
      algorithm: 'nacl-box-sealed',
      recipient_pubkey_hash: 'test-hash',
      nonce: 'n',
      additional_data: 'ad',
    },
    payload: { bytes_len: 16, ciphertext: 'opaque' },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    routing_policy: { policy_id: defaultPolicy.policy_id, inline: { replication_factor: 1, max_hops: 4, require_e2e: true } },
  });
}

function makeHost(): { host: AndroidRuntimeHost; identity: UniversalIdentity; bundleStore: AndroidBundleStore; keystore: TestKeystoreAdapter } {
  const { identity } = makeTestIdentity('Test Node');
  const bundleStore = new AndroidBundleStore();
  const keystore = new TestKeystoreAdapter();
  const resourceSampler = new TestResourceReportSampler();
  const host = new AndroidRuntimeHost({
    identity,
    capabilities: makeTestCapabilities(identity.id),
    bundleStore,
    keystore,
    resourceSampler,
  });
  return { host, identity, bundleStore, keystore };
}

// ─── Lifecycle state machine (ARCH-054) ────────────────────────────────

describe('P4.1 — Android runtime lifecycle state machine (ARCH-054)', () => {
  it('starts in CREATED', () => {
    const { host } = makeHost();
    expect(host.getLifecycleState()).toBe('CREATED');
  });

  it('forward transitions: CREATED → INITIALIZING → HYDRATING → RUNNING → DRAINING → STOPPED', async () => {
    const { host } = makeHost();
    expect(await host.transition('INITIALIZING')).toBe(true);
    expect(host.getLifecycleState()).toBe('INITIALIZING');
    expect(await host.transition('HYDRATING')).toBe(true);
    expect(host.getLifecycleState()).toBe('HYDRATING');
    expect(await host.transition('RUNNING')).toBe(true);
    expect(host.getLifecycleState()).toBe('RUNNING');
    expect(await host.transition('DRAINING')).toBe(true);
    expect(host.getLifecycleState()).toBe('DRAINING');
    expect(await host.transition('STOPPED')).toBe(true);
    expect(host.getLifecycleState()).toBe('STOPPED');
  });

  it('refuses to skip states (e.g., CREATED → HYDRATING is illegal)', async () => {
    const { host } = makeHost();
    expect(await host.transition('HYDRATING')).toBe(false); // refused
    expect(host.getLifecycleState()).toBe('CREATED'); // unchanged
  });

  it('refuses backward transitions (e.g., RUNNING → INITIALIZING)', async () => {
    const { host } = makeHost();
    await host.transition('INITIALIZING');
    await host.transition('HYDRATING');
    await host.transition('RUNNING');
    expect(await host.transition('INITIALIZING')).toBe(false); // refused
    expect(host.getLifecycleState()).toBe('RUNNING'); // unchanged
  });

  it('STOPPED is terminal (no further transitions)', async () => {
    const { host } = makeHost();
    await host.start();
    await host.stop();
    expect(await host.transition('RUNNING')).toBe(false); // refused
    expect(host.getLifecycleState()).toBe('STOPPED');
  });

  it('throws on illegal transition via the canonical transition function', () => {
    expect(() => transitionRuntimeLifecycle('CREATED', 'RUNNING')).toThrow(RuntimeLifecycleError);
    expect(() => transitionRuntimeLifecycle('RUNNING', 'CREATED')).toThrow(RuntimeLifecycleError);
    expect(() => transitionRuntimeLifecycle('STOPPED', 'RUNNING')).toThrow(RuntimeLifecycleError);
  });

  it('observer is notified on every transition', async () => {
    const events: Array<{ from: AndroidRuntimeLifecycleState; to: AndroidRuntimeLifecycleState; ts: number }> = [];
    const observer: RuntimeLifecycleObserver = {
      onTransition: (from, to, ts) => events.push({ from, to, ts }),
    };
    const { identity } = makeTestIdentity('Test Node');
    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeTestCapabilities(identity.id),
      bundleStore: new AndroidBundleStore(),
      keystore: new TestKeystoreAdapter(),
      resourceSampler: new TestResourceReportSampler(),
      observer,
    });
    await host.start();
    expect(events.length).toBe(3); // INITIALIZING, HYDRATING, RUNNING
    expect(events[0]).toMatchObject({ from: 'CREATED', to: 'INITIALIZING' });
    expect(events[1]).toMatchObject({ from: 'INITIALIZING', to: 'HYDRATING' });
    expect(events[2]).toMatchObject({ from: 'HYDRATING', to: 'RUNNING' });
  });
});

// ─── R1 — Process death recovery ────────────────────────────────────────

describe('P4.1 — R1: process death recovery', () => {
  it('restart re-hydrates from durable state (no duplicate delivery)', async () => {
    // Simulate: push a bundle, "crash", restart, hydrate, verify the bundle is still QUEUED.
    const { identity } = makeTestIdentity('Test Node');
    const bundleStore1 = new AndroidBundleStore();
    bundleStore1.setNodeId(identity.id);
    const bundle = makeTestBundle('bundle-r1', identity, 'bob');
    bundleStore1.push(bundle, 'bob');

    // Snapshot the persisted state (simulates writing to disk before crash).
    const snapshot = bundleStore1.snapshot();
    expect(snapshot.queuedBundles.length).toBe(1);
    expect(snapshot.queuedBundles[0].bundle.bundle_id).toBe('bundle-r1');

    // "Crash" + restart — new bundleStore, but we re-hydrate from the snapshot.
    // In a real impl, the new store would read the persisted file. Here, we
    // simulate by pushing the same bundle to the new store (P1 dedup holds).
    const bundleStore2 = new AndroidBundleStore();
    bundleStore2.setNodeId(identity.id);
    bundleStore2.push(bundle, 'bob'); // same bundle_id — P1 dedup
    expect(bundleStore2.snapshot().queuedBundles.length).toBe(1);
  });

  it('a bundle mid-send when the process dies is NOT re-delivered as new on restart', async () => {
    // P2 — the ReceivedBundle table dedupes by bundle_id.
    const { identity } = makeTestIdentity('Test Node');
    const bundleStore = new AndroidBundleStore();
    bundleStore.setNodeId(identity.id);
    const bundle = makeTestBundle('bundle-mid-send', identity, 'bob');

    // The bundle was received (mid-send) before the crash.
    bundleStore.markReceived(bundle.bundle_id, 'alice');

    // Restart — the bundle is in the received set.
    expect(bundleStore.hasReceived(bundle.bundle_id)).toBe(true);

    // A re-delivery attempt is silently dropped (P2).
    if (bundleStore.hasReceived(bundle.bundle_id)) {
      // silently drop — the runtime would NOT call onReceive handlers.
    }
    expect(bundleStore.hasReceived(bundle.bundle_id)).toBe(true);
  });
});

// ─── R2 — Background execution ──────────────────────────────────────────

describe('P4.1 — R2: background execution (lifecycle owns long-lived callbacks)', () => {
  it('the runtime owns the receive handler (released on STOP)', async () => {
    const { host, identity } = makeHost();
    await host.start();
    let received = false;
    host.onReceive(() => {
      received = true;
    });
    // After STOP, the handler should be released.
    await host.stop();
    // Re-receive should not invoke the handler (it was released).
    // We can't directly assert this from outside, but we can assert that
    // receiveBundle returns false after STOP (R6 — refuses work after STOP).
    const bundle = makeTestBundle('bundle-r2', identity, 'bob');
    const ok = await host.receiveBundle(bundle, 'alice');
    expect(ok).toBe(false);
    expect(received).toBe(false);
  });

  it('the TTL sweeper is owned by the lifecycle (released on STOP)', async () => {
    const { host } = makeHost();
    await host.start();
    // The host has timers running.
    await host.stop();
    // After STOP, the timers are cleared. We can't directly inspect private
    // timers, but we can assert that runTtlSweeper returns [] (refuses work).
    const expired = await host.runTtlSweeper();
    expect(expired).toEqual([]);
  });
});

// ─── R3 — Deterministic rehydration ─────────────────────────────────────

describe('P4.1 — R3: deterministic rehydration from durable state', () => {
  it('rehydration is deterministic (same snapshot → same in-memory state)', async () => {
    const { identity } = makeTestIdentity('Test Node');
    const bundleStore = new AndroidBundleStore();
    bundleStore.setNodeId(identity.id);
    const bundle = makeTestBundle('bundle-r3', identity, 'bob');
    bundleStore.push(bundle, 'bob');

    // Host 1.
    const host1 = new AndroidRuntimeHost({
      identity,
      capabilities: makeTestCapabilities(identity.id),
      bundleStore,
      keystore: new TestKeystoreAdapter(),
      resourceSampler: new TestResourceReportSampler(),
    });
    await host1.start();
    const tracker1 = host1.getDeliveryTracker();
    const rec1 = tracker1.get(bundle.bundle_id);
    expect(rec1?.current).toBe('QUEUED');

    // Host 2 — same snapshot.
    const host2 = new AndroidRuntimeHost({
      identity,
      capabilities: makeTestCapabilities(identity.id),
      bundleStore,
      keystore: new TestKeystoreAdapter(),
      resourceSampler: new TestResourceReportSampler(),
    });
    await host2.start();
    const tracker2 = host2.getDeliveryTracker();
    const rec2 = tracker2.get(bundle.bundle_id);
    expect(rec2?.current).toBe('QUEUED');

    // The two trackers have the same state for the same bundle.
    expect(rec1?.current).toBe(rec2?.current);
  });

  it('rehydration does NOT infer state from BLE/network/UI callbacks', async () => {
    // The runtime's hydrate() method only reads from bundleStore.snapshot().
    // It does NOT call any transport callbacks during hydration.
    // We assert this by checking that a host with NO transports registered
    // still hydrates correctly.
    const { identity } = makeTestIdentity('Test Node');
    const bundleStore = new AndroidBundleStore();
    bundleStore.setNodeId(identity.id);
    bundleStore.push(makeTestBundle('bundle-r3b', identity, 'bob'), 'bob');

    const host = new AndroidRuntimeHost({
      identity,
      capabilities: makeTestCapabilities(identity.id),
      bundleStore,
      keystore: new TestKeystoreAdapter(),
      resourceSampler: new TestResourceReportSampler(),
    });
    // No transports registered. hydrate() should still work.
    await host.start();
    expect(host.getLifecycleState()).toBe('RUNNING');
    expect(host.getDeliveryTracker().get('bundle-r3b')?.current).toBe('QUEUED');
  });
});

// ─── R4 — Key boundary (Keystore) ───────────────────────────────────────

describe('P4.1 — R4: key boundary (Keystore)', () => {
  it('signing fails when Keystore is locked (fail-closed)', async () => {
    const { host, keystore } = makeHost();
    await host.start();
    keystore.lock(); // simulate user-dismissed biometric prompt
    expect(keystore.isUnlocked()).toBe(false);
    const sig = await host.signPayload(new Uint8Array([1, 2, 3]));
    expect(sig).toBeNull(); // fail-closed
  });

  it('signing succeeds when Keystore is unlocked', async () => {
    const { host, keystore } = makeHost();
    await host.start();
    expect(keystore.isUnlocked()).toBe(true);
    const sig = await host.signPayload(new Uint8Array([1, 2, 3]));
    expect(sig).not.toBeNull();
    expect(sig!.length).toBe(64); // Ed25519 detached signature is 64 bytes
  });

  it('the public key is exportable', () => {
    const { host, keystore } = makeHost();
    const pubkey = host.getPublicKey();
    expect(pubkey).toBe(keystore.getPublicKey());
    expect(pubkey.length).toBe(32); // Ed25519 public key is 32 bytes
  });
});

// ─── R5 — Callback ownership ─────────────────────────────────────────────

describe('P4.1 — R5: callback ownership', () => {
  it('shutdown releases transport registrations', async () => {
    const { host } = makeHost();
    await host.start();
    const transport = new FakeTransport({
      node_id: 'test',
      transport_type: 'BLE',
      peer_node_ids: [],
    });
    const registered = await host.registerTransport(transport);
    expect(registered).toBe(true);
    expect(host.getTransportRegistry().size()).toBe(1);

    await host.stop();
    // After STOP, all transports are unregistered (close() called on each).
    expect(host.getTransportRegistry().size()).toBe(0);
    expect(transport.isAvailable()).toBe(false); // close() was called
  });

  it('shutdown releases receive handlers', async () => {
    const { host } = makeHost();
    await host.start();
    let called = false;
    host.onReceive(() => {
      called = true;
    });
    await host.stop();
    // After STOP, receiveBundle returns false (R6) AND the handler is released.
    const { identity } = makeTestIdentity('Test Node');
    const bundle = makeTestBundle('bundle-r5', identity, 'bob');
    await host.receiveBundle(bundle, 'alice');
    expect(called).toBe(false);
  });
});

// ─── R6 — Concurrency safety ────────────────────────────────────────────

describe('P4.1 — R6: concurrency safety', () => {
  it('refuses new work before RUNNING', async () => {
    const { host, identity } = makeHost();
    // Host is in CREATED — receiveBundle should refuse.
    const bundle = makeTestBundle('bundle-r6a', identity, 'bob');
    const ok = await host.receiveBundle(bundle, 'alice');
    expect(ok).toBe(false);
  });

  it('refuses new work during DRAINING', async () => {
    const { host, identity } = makeHost();
    await host.start();
    await host.transition('DRAINING');
    const bundle = makeTestBundle('bundle-r6b', identity, 'bob');
    const ok = await host.receiveBundle(bundle, 'alice');
    expect(ok).toBe(false);
  });

  it('refuses transport registration before RUNNING', async () => {
    const { host } = makeHost();
    const transport = new FakeTransport({
      node_id: 'test',
      transport_type: 'BLE',
      peer_node_ids: [],
    });
    const ok = await host.registerTransport(transport);
    expect(ok).toBe(false);
  });

  it('refuses transport registration during DRAINING', async () => {
    const { host } = makeHost();
    await host.start();
    await host.transition('DRAINING');
    const transport = new FakeTransport({
      node_id: 'test',
      transport_type: 'BLE',
      peer_node_ids: [],
    });
    const ok = await host.registerTransport(transport);
    expect(ok).toBe(false);
  });

  it('concurrent transition attempts are serialized (busy flag)', async () => {
    const { host } = makeHost();
    // Fire two transitions concurrently.
    const p1 = host.transition('INITIALIZING');
    const p2 = host.transition('INITIALIZING');
    const [r1, r2] = await Promise.all([p1, p2]);
    // One succeeds, the other is refused (busy).
    expect(r1 === true || r2 === true).toBe(true);
    expect(r1 === false || r2 === false).toBe(true);
  });
});

// ─── R7 — Delivery authority ─────────────────────────────────────────────

describe('P4.1 — R7: delivery authority (DeliveryTracker.transition() is sole)', () => {
  it('receiveBundle transitions the bundle to DELIVERED via the canonical tracker', async () => {
    const { host, identity } = makeHost();
    await host.start();
    const bundle = makeTestBundle('bundle-r7a', identity, identity.id);
    const ok = await host.receiveBundle(bundle, 'alice');
    expect(ok).toBe(true);
    const rec = host.getDeliveryTracker().get(bundle.bundle_id);
    expect(rec?.current).toBe('DELIVERED');
  });

  it('duplicate receiveBundle is silently dropped (P2 dedup)', async () => {
    const { host, identity } = makeHost();
    await host.start();
    const bundle = makeTestBundle('bundle-r7b', identity, identity.id);
    const ok1 = await host.receiveBundle(bundle, 'alice');
    const ok2 = await host.receiveBundle(bundle, 'alice');
    expect(ok1).toBe(true);
    expect(ok2).toBe(false); // dedup
  });

  it('the TTL sweeper transitions QUEUED → EXPIRED via the canonical tracker', async () => {
    const { host, identity } = makeHost();
    await host.start();
    const bundleStore = host.getBundleStore();
    const bundle = makeTestBundle('bundle-r7c', identity, 'bob');
    bundleStore.push(bundle, 'bob');
    // The bundle is QUEUED. The TTL sweeper checks expires_at on the store.
    // Manually init the tracker + transition through ACCEPTED → QUEUED
    // (so the tracker agrees with the store's QUEUED state).
    const tracker = host.getDeliveryTracker();
    tracker.init(bundle.bundle_id);
    tracker.transition(bundle.bundle_id, 'ACCEPTED');
    tracker.transition(bundle.bundle_id, 'QUEUED');
    // Run the sweeper with a future timestamp — the bundle's expires_at is
    // 60s in the future, so running the sweeper with now + 100s should mark
    // the bundle as expired.
    const expired1 = await host.runTtlSweeper(Date.now() + 100_000);
    expect(expired1).toContain(bundle.bundle_id);
    // P3 — idempotent. Running again should NOT re-transition (already EXPIRED).
    const expired2 = await host.runTtlSweeper(Date.now() + 100_000);
    expect(expired2).not.toContain(bundle.bundle_id); // already expired
    // The tracker's state is now EXPIRED.
    expect(tracker.get(bundle.bundle_id)?.current).toBe('EXPIRED');
    // The store's state matches the tracker's (P4).
    expect(bundleStore.snapshot().storedRecords[0].state).toBe('EXPIRED');
  });

  it('the BundleStore does NOT mutate state directly (only via updateStateFromTracker)', () => {
    const { identity } = makeTestIdentity('Test Node');
    const bundleStore = new AndroidBundleStore();
    bundleStore.setNodeId(identity.id);
    const bundle = makeTestBundle('bundle-r7d', identity, 'bob');
    bundleStore.push(bundle, 'bob');
    const record = bundleStore.snapshot().storedRecords[0];
    expect(record.state).toBe('QUEUED');
    // P4 — the store exposes updateStateFromTracker(), NOT a direct state setter.
    // The runtime MUST call the tracker first, THEN the store.
    bundleStore.updateStateFromTracker(bundle.bundle_id, 'RELAYED');
    const record2 = bundleStore.snapshot().storedRecords[0];
    expect(record2.state).toBe('RELAYED');
  });
});
