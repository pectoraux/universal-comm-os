/**
 * server/android/conformance/FakeTransport.ts — P4.1
 *
 * A deterministic test fixture implementing the canonical `Transport`
 * interface (src/core/transport/Transport.ts). Used by the
 * TransportConformanceSuite to prove transport-agnostic invariants.
 *
 * NOT FOR PRODUCTION. Clearly named `Fake` and located in
 * `conformance/` — Article X (No Fake Implementations) carve-out for
 * explicitly-isolated test fixtures applies.
 *
 * The FakeTransport:
 *   - Implements the 4 Transport methods (isAvailable, send, onReceive, close).
 *   - Returns the 4 canonical TransportSendResult kinds (OK, UNAVAILABLE, NO_PEER, ERROR).
 *   - NEVER throws (Article XVIII §2 — no exceptions across the boundary).
 *   - Does NOT decrypt bundles (Article XVIII §3 — bundles are opaque).
 *   - Does NOT introduce new TransportSendResult kinds (Article XVIII §1).
 *   - Does NOT modify the bundle (Article XVIII §3 — framing is ephemeral).
 *   - Supports the duck-typed gossip() / onGossip() side-channel (ARCH-031).
 *
 * The FakeTransport records sent bundles + received bundles in internal
 * buffers so tests can assert round-trip behavior.
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { TransportCapabilityType } from '@/core/capabilities/types';
import type { Transport, TransportSendResult } from '@/core/transport/Transport';

export interface FakeTransportConfig {
  node_id: string;
  transport_type: TransportCapabilityType;
  /** Set to false to simulate radio off / link down. */
  available?: boolean;
  /** Set of peer node_ids this transport can reach. */
  peer_node_ids?: string[];
  /**
   * Optional: a "wire" function that delivers bundles to another
   * FakeTransport (simulating BLE/Wi-Fi Direct delivery). When omitted,
   * send() to a peer in peer_node_ids returns OK without delivery
   * (the test asserts the TransportSendResult only).
   */
  wire?: (to_node_id: string, bundle: CommunicationBundle) => boolean;
}

export class FakeTransport implements Transport {
  readonly transport_id: string;
  readonly transport_type: TransportCapabilityType;
  readonly node_id: string;

  private available: boolean;
  private peers: Set<string>;
  private readonly wire?: (to_node_id: string, bundle: CommunicationBundle) => boolean;
  private readonly receivers: Set<(bundle: CommunicationBundle, from_node_id: string) => void> = new Set();
  private readonly gossipReceivers: Set<(ad: unknown, from_node_id: string) => void> = new Set();

  // Buffers for test assertions.
  readonly sentBundles: Array<{ bundle: CommunicationBundle; to_node_id: string; ts: number }> = [];
  readonly receivedBundles: Array<{ bundle: CommunicationBundle; from_node_id: string; ts: number }> = [];
  readonly gossipMessages: Array<{ ad: unknown; from_node_id: string; ts: number }> = [];

  constructor(config: FakeTransportConfig) {
    this.transport_id = `fake:${config.node_id}:${config.transport_type}`;
    this.transport_type = config.transport_type;
    this.node_id = config.node_id;
    this.available = config.available ?? true;
    this.peers = new Set(config.peer_node_ids ?? []);
    this.wire = config.wire;
  }

  // ─── Transport interface (Article XVIII §1 — 4 canonical methods) ────

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Send a bundle. Returns one of the 4 canonical TransportSendResult kinds.
   * NEVER throws (Article XVIII §2).
   */
  async send(bundle: CommunicationBundle, to_node_id: string): Promise<TransportSendResult> {
    if (!this.available) {
      return { kind: 'UNAVAILABLE', reason: 'transport is down' };
    }
    if (!this.peers.has(to_node_id)) {
      return { kind: 'NO_PEER', reason: `${to_node_id} not in peer set` };
    }
    // Article XVIII §3 — the bundle is opaque. We do NOT decrypt or
    // interpret it. We pass it to the wire (if defined) or just record it.
    this.sentBundles.push({ bundle, to_node_id, ts: Date.now() });
    if (this.wire) {
      const ok = this.wire(to_node_id, bundle);
      if (!ok) {
        return { kind: 'ERROR', reason: 'wire delivery failed' };
      }
    }
    return { kind: 'OK', forwarded_at: Date.now() };
  }

  onReceive(handler: (bundle: CommunicationBundle, from_node_id: string) => void): void {
    this.receivers.add(handler);
  }

  async close(): Promise<void> {
    this.available = false;
    this.receivers.clear();
    this.gossipReceivers.clear();
  }

  // ─── Gossip side-channel (ARCH-031 — duck-typed, NOT on Transport) ────
  // Article XVIII §11 — only acceptable payload kinds. The FakeTransport
  // does NOT validate payload kinds (that's the responsibility of the
  // static AST scan in tests/architecture/p41-architecture-enforcement.test.ts).

  gossip(ad: unknown): boolean {
    if (!this.available) return false;
    // The wire function is for bundles, not gossip. For gossip delivery,
    // the test wires the FakeTransport's onGossip handler directly.
    return true;
  }

  onGossip(handler: (ad: unknown, from_node_id: string) => void): void {
    this.gossipReceivers.add(handler);
  }

  /** Internal: deliver a gossip message to this transport's gossipReceivers. */
  _ingestGossip(ad: unknown, from_node_id: string): void {
    this.gossipMessages.push({ ad, from_node_id, ts: Date.now() });
    for (const h of this.gossipReceivers) {
      try {
        h(ad, from_node_id);
      } catch {
        // Article XVIII §2 — no exceptions across the boundary.
      }
    }
  }

  /** Internal: deliver a bundle to this transport's receivers. */
  _ingest(bundle: CommunicationBundle, from_node_id: string): void {
    this.receivedBundles.push({ bundle, from_node_id, ts: Date.now() });
    for (const r of this.receivers) {
      try {
        r(bundle, from_node_id);
      } catch {
        // Article XVIII §2 — no exceptions across the boundary.
      }
    }
  }

  // ─── Test-only controls ─────────────────────────────────────────────────

  setAvailable(up: boolean): void {
    this.available = up;
  }

  addPeer(id: string): void {
    this.peers.add(id);
  }

  removePeer(id: string): void {
    this.peers.delete(id);
  }

  getPeers(): string[] {
    return Array.from(this.peers);
  }
}
