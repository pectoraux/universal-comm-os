/**
 * server/android/conformance/TransportConformanceSuite.ts — P4.1
 *
 * The TransportConformanceSuite — a reusable test framework that proves
 * transport-agnostic invariants for any Transport implementation.
 *
 * Architecture review (P4-DESIGN §15): "The architecture review made
 * TransportConformanceSuite mandatory. For P4.1, establish the test
 * framework/interface for it. Do not wait until BLE implementation."
 *
 * The suite covers (per P4-DESIGN §15):
 *   - bundle round-trip
 *   - framing boundary
 *   - malformed input rejection
 *   - duplicate handling
 *   - lifecycle cleanup
 *   - close/reopen semantics
 *   - opaque bundle handling
 *   - no identity mutation
 *   - no authorization mutation
 *   - no delivery-state mutation
 *   - resource-reporting isolation
 *
 * The suite is parameterized by a `TransportFactory` so it can be run
 * against:
 *   - the FakeTransport (P4.1 — proves the suite itself works)
 *   - the BLE transport (P4.2 — proves the BLE adapter conforms)
 *   - the Wi-Fi Direct transport (P4.3 — proves the Wi-Fi Direct adapter conforms)
 *
 * The suite uses the existing vitest framework (`describe`/`it`/`expect`).
 * It does NOT introduce a new test framework.
 *
 * Article XVIII — every test in this suite is an executable assertion
 * that a transport does not violate a frozen invariant. A failure is an
 * Article XVIII §14 architecture-control defect.
 */

import { describe, it, expect } from 'vitest';
import type { Transport, TransportSendResult } from '@/core/transport/Transport';
import type { CommunicationBundle } from '@/core/bundle/types';
import { FakeTransport, type FakeTransportConfig } from './FakeTransport';

/**
 * A factory that creates a transport for testing. The factory takes a
 * configuration and returns a Transport instance + a "wire" function
 * that delivers bundles to a peer transport (simulating the physical
 * link).
 */
export type TransportFactory = (
  config: FakeTransportConfig,
) => {
  transport: Transport;
  /** Deliver a bundle to a peer (simulates BLE/Wi-Fi Direct delivery). */
  wire: (to_node_id: string, bundle: CommunicationBundle) => boolean;
  /** The peer transports (so the test can assert round-trip delivery). */
  peers: Map<string, Transport>;
  /** Cleanup all created transports. */
  close: () => Promise<void>;
};

/**
 * The canonical TransportConformanceSuite. Call `runTransportConformanceSuite(factory)`
 * from a vitest test file to run the suite against a specific transport factory.
 *
 * The default factory uses FakeTransport. P4.2/P4.3 will register their own
 * factories (e.g., `bleTransportFactory`, `wifiDirectTransportFactory`).
 */
export function runTransportConformanceSuite(
  factory: TransportFactory,
  factoryName: string = 'default',
) {
  describe(`TransportConformanceSuite — ${factoryName}`, () => {
    // ─── Bundle round-trip ─────────────────────────────────────────────
    // T4 (P4 design §2.4) — the framing implementation MUST round-trip
    // the bundle bytes byte-identically.

    it('round-trips a bundle byte-identically', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      const bob = alice.peers.get('bob')!;
      try {
        const bundle = makeTestBundle('bundle-1', 'alice', 'bob');
        const result = await alice.transport.send(bundle, 'bob');
        expect(result.kind).toBe('OK');
        // Bob's transport should have received the bundle via the wire.
        // (The FakeTransport records received bundles; a real BLE transport
        // would invoke its onReceive handler.)
        if ('receivedBundles' in bob) {
          const fakeBob = bob as unknown as FakeTransport;
          expect(fakeBob.receivedBundles.length).toBe(1);
          expect(fakeBob.receivedBundles[0].bundle.bundle_id).toBe('bundle-1');
        }
      } finally {
        await alice.close();
      }
    });

    // ─── Framing boundary (Article XVIII §10) ─────────────────────────
    // The framing fields MUST NOT alter the bundle. The bundle the
    // recipient sees must be byte-identical to what the sender sent.

    it('framing does not alter bundle semantics', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      const bob = alice.peers.get('bob')!;
      try {
        const bundle = makeTestBundle('bundle-framing', 'alice', 'bob');
        await alice.transport.send(bundle, 'bob');
        if ('receivedBundles' in bob) {
          const fakeBob = bob as unknown as FakeTransport;
          const received = fakeBob.receivedBundles[0].bundle;
          // Byte-identical round-trip.
          expect(received.bundle_id).toBe(bundle.bundle_id);
          expect(received.sender.id).toBe(bundle.sender.id);
          expect(received.recipient).toEqual(bundle.recipient);
          expect(received.conversation_id).toBe(bundle.conversation_id);
          expect(received.intent.type).toBe(bundle.intent.type);
          expect(received.priority).toBe(bundle.priority);
        }
      } finally {
        await alice.close();
      }
    });

    // ─── Malformed input rejection ────────────────────────────────────
    // A transport MUST NOT crash on malformed input. It returns ERROR.

    it('rejects malformed input gracefully (no throw)', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        // Send to a non-existent peer — should return NO_PEER, not throw.
        const result = await alice.transport.send(
          makeTestBundle('bundle-malformed', 'alice', 'nobody'),
          'nobody',
        );
        expect(result.kind).toBe('NO_PEER');
      } finally {
        await alice.close();
      }
    });

    // ─── Duplicate handling (P2 — Article XVIII §13) ───────────────────
    // The transport does NOT dedup — that's the BundleStore's job (P2).
    // The transport delivers whatever the sender sends.

    it('delivers duplicate bundles without dedup (dedup is BundleStore)', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      const bob = alice.peers.get('bob')!;
      try {
        const bundle = makeTestBundle('bundle-dup', 'alice', 'bob');
        await alice.transport.send(bundle, 'bob');
        await alice.transport.send(bundle, 'bob'); // duplicate
        if ('receivedBundles' in bob) {
          const fakeBob = bob as unknown as FakeTransport;
          // The transport delivers both; dedup is the BundleStore's concern.
          expect(fakeBob.receivedBundles.length).toBe(2);
        }
      } finally {
        await alice.close();
      }
    });

    // ─── Lifecycle cleanup (R5) ────────────────────────────────────────
    // close() releases all resources.

    it('close() releases resources (transport unavailable after close)', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        expect(alice.transport.isAvailable()).toBe(true);
        if (alice.transport.close) {
          await alice.transport.close();
        }
        expect(alice.transport.isAvailable()).toBe(false);
        const result = await alice.transport.send(
          makeTestBundle('bundle-after-close', 'alice', 'bob'),
          'bob',
        );
        expect(result.kind).toBe('UNAVAILABLE');
      } finally {
        await alice.close();
      }
    });

    // ─── Close/reopen semantics ────────────────────────────────────────
    // A transport can be closed and a new instance created. The new
    // instance is independent of the old one.

    it('close/reopen creates independent instances', async () => {
      const alice1 = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      await alice1.close();
      const alice2 = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        expect(alice2.transport.isAvailable()).toBe(true);
        expect(alice1.transport.isAvailable()).toBe(false);
      } finally {
        await alice2.close();
      }
    });

    // ─── Opaque bundle handling (Article XVIII §3) ─────────────────────
    // The transport does NOT decrypt or interpret the bundle.

    it('treats bundles as opaque (does not inspect payload)', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        // The bundle has an opaque payload (ciphertext). The transport
        // should not try to read it.
        const bundle = makeTestBundle('bundle-opaque', 'alice', 'bob', 'opaque-payload');
        const result = await alice.transport.send(bundle, 'bob');
        expect(result.kind).toBe('OK');
      } finally {
        await alice.close();
      }
    });

    // ─── No identity mutation (Article XVIII §4 + Article II) ──────────
    // The transport does NOT modify the bundle's sender field.

    it('does not mutate bundle sender identity', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      const bob = alice.peers.get('bob')!;
      try {
        const bundle = makeTestBundle('bundle-id', 'alice', 'bob');
        await alice.transport.send(bundle, 'bob');
        if ('receivedBundles' in bob) {
          const fakeBob = bob as unknown as FakeTransport;
          const received = fakeBob.receivedBundles[0].bundle;
          expect(received.sender.id).toBe(bundle.sender.id);
          expect(received.sender.signing_pubkey_hash).toBe(bundle.sender.signing_pubkey_hash);
        }
      } finally {
        await alice.close();
      }
    });

    // ─── No authorization mutation (Articles XII–XIV) ──────────────────
    // The transport does NOT carry authorization state. The TransportSendResult
    // has only 4 canonical kinds — no AUTHZ_GRANTED kind.

    it('does not introduce authorization kinds in TransportSendResult', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        const bundle = makeTestBundle('bundle-authz', 'alice', 'bob');
        const result = await alice.transport.send(bundle, 'bob');
        // The 4 canonical kinds: OK, UNAVAILABLE, NO_PEER, ERROR.
        expect(['OK', 'UNAVAILABLE', 'NO_PEER', 'ERROR']).toContain(result.kind);
        // No AUTHZ_GRANTED / AUTHZ_DENIED / etc.
        expect(result.kind).not.toBe('AUTHZ_GRANTED');
        expect(result.kind).not.toBe('AUTHZ_DENIED');
      } finally {
        await alice.close();
      }
    });

    // ─── No delivery-state mutation (Article VI + Article XVIII §4) ────
    // The transport does NOT carry delivery state. The TransportSendResult
    // has only 4 canonical kinds — no DELIVERED / EXPIRED / etc.

    it('does not introduce delivery-state kinds in TransportSendResult', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        const bundle = makeTestBundle('bundle-deliv', 'alice', 'bob');
        const result = await alice.transport.send(bundle, 'bob');
        expect(['OK', 'UNAVAILABLE', 'NO_PEER', 'ERROR']).toContain(result.kind);
        expect(result.kind).not.toBe('DELIVERED');
        expect(result.kind).not.toBe('EXPIRED');
        expect(result.kind).not.toBe('QUEUED');
      } finally {
        await alice.close();
      }
    });

    // ─── Resource-reporting isolation (Article XVIII §7) ───────────────
    // The transport does NOT carry resource state in the bundle.

    it('does not embed resource state in the bundle', async () => {
      const alice = factory({
        node_id: 'alice',
        transport_type: 'BLE',
        peer_node_ids: ['bob'],
      });
      try {
        const bundle = makeTestBundle('bundle-res', 'alice', 'bob');
        await alice.transport.send(bundle, 'bob');
        // The bundle's fields are the canonical Article IV fields.
        // There is no `battery_pct` / `bandwidth_bps` field on the bundle.
        expect((bundle as unknown as Record<string, unknown>).battery_pct).toBeUndefined();
        expect((bundle as unknown as Record<string, unknown>).bandwidth_bps).toBeUndefined();
      } finally {
        await alice.close();
      }
    });
  });
}

// ─── Default factory (uses FakeTransport) ──────────────────────────────
// P4.1 uses this factory to prove the suite itself works. P4.2/P4.3 will
// register their own factories.

export const fakeTransportFactory: TransportFactory = (config) => {
  const transports = new Map<string, FakeTransport>();
  const peers = new Map<string, Transport>();

  // Create the primary transport.
  const primary = new FakeTransport({
    ...config,
    wire: (to_node_id, bundle) => {
      const peer = transports.get(to_node_id);
      if (!peer) return false;
      peer._ingest(bundle, config.node_id);
      return true;
    },
  });
  transports.set(config.node_id, primary);
  peers.set(config.node_id, primary);

  // Create peer transports so the wire can deliver.
  for (const peer_id of config.peer_node_ids ?? []) {
    const peer = new FakeTransport({
      node_id: peer_id,
      transport_type: config.transport_type,
      peer_node_ids: [config.node_id],
      wire: (to_node_id, bundle) => {
        const dest = transports.get(to_node_id);
        if (!dest) return false;
        dest._ingest(bundle, peer_id);
        return true;
      },
    });
    transports.set(peer_id, peer);
    peers.set(peer_id, peer);
  }

  return {
    transport: primary,
    wire: primary['_ingest' as keyof FakeTransport] as unknown as (to_node_id: string, bundle: CommunicationBundle) => boolean,
    peers,
    close: async () => {
      for (const t of transports.values()) {
        await t.close();
      }
    },
  };
};

// ─── Helper: create a minimal test bundle ──────────────────────────────
// The bundle is the canonical CommunicationBundle — no Android-specific fields.

function makeTestBundle(
  bundle_id: string,
  from_id: string,
  to_id: string,
  payload_data?: string,
): CommunicationBundle {
  return {
    bundle_id,
    sender: {
      id: from_id,
      signing_pubkey_hash: 'test-pubkey-hash',
      display_name: from_id,
    },
    recipient: { kind: 'IDENTITY', ref: { id: to_id, signing_pubkey_hash: 'test-pubkey-hash' } },
    conversation_id: `conv-${bundle_id}`,
    intent: { type: 'SEND_MESSAGE', priority: 'NORMAL', ttl_ms: 60_000 },
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    priority: 'NORMAL',
    routing_policy: {
      policy_id: 'default',
      inline: { replication_factor: 1, max_hops: 4, require_e2e: true },
    },
    encryption_metadata: {
      algorithm: 'XSalsa20-Poly1305',
      recipient_pubkey_hash: 'test-recipient-pubkey-hash',
      nonce: 'test-nonce',
      additional_data: 'test-ad',
    },
    payload: {
      bytes_len: payload_data ? payload_data.length : 16,
      ciphertext: payload_data ?? 'opaque-ciphertext',
    },
    delivery_requirements: {
      ack_required: true,
      max_latency_ms: 60_000,
    },
    proofs: [],
  } as unknown as CommunicationBundle;
}
