/**
 * transport/loopback/LoopbackTransport.ts
 *
 * P2 — Local Transport (ARCH-015).
 *
 * An in-process transport that lets us prove Bundle -> transport -> destination
 * without any external network. Each LoopbackTransport has a node id and a
 * registry of peer LoopbackTransports it can directly reach.
 *
 * This implementation is REAL: it actually delivers bytes between nodes via
 * an in-process event bus. It is NOT a fake. It is an isolated test/development
 * transport that P2 explicitly allows.
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { TransportCapabilityType } from '@/core/capabilities/types';
import type { Transport, TransportSendResult } from '@/core/transport/Transport';
import { createTransportEventSink, type TransportEventSink } from '@/core/transport/TransportEvent';

interface LoopbackConfig {
  node_id: string;
  transport_type: TransportCapabilityType;
  peer_node_ids?: string[];
}

export class LoopbackTransport implements Transport {
  readonly transport_id: string;
  readonly transport_type: TransportCapabilityType;
  readonly node_id: string;

  private peers = new Set<string>();
  private receivers = new Set<(bundle: CommunicationBundle, from_node_id: string) => void>();
  private up = true;
  readonly events: TransportEventSink;

  /**
   * A reference to the shared bus. All loopback transports attached to the
   * same bus can reach each other (subject to `peer_node_ids` allow-list).
   */
  private bus: LoopbackBus;

  constructor(config: LoopbackConfig, bus: LoopbackBus) {
    this.transport_id = `loopback:${config.node_id}:${config.transport_type}`;
    this.transport_type = config.transport_type;
    this.node_id = config.node_id;
    this.bus = bus;
    this.bus.register(this);
    if (config.peer_node_ids) {
      for (const p of config.peer_node_ids) this.peers.add(p);
    }
    this.events = createTransportEventSink();
  }

  setPeers(ids: string[]): void {
    this.peers = new Set(ids);
  }

  addPeer(id: string): void {
    this.peers.add(id);
  }

  setUp(up: boolean): void {
    this.up = up;
    this.events.emit({
      name: up ? 'transport_up' : 'transport_down',
      ts: Date.now(),
      transport_id: this.transport_id,
    });
  }

  isAvailable(): boolean {
    return this.up;
  }

  async send(bundle: CommunicationBundle, to_node_id: string): Promise<TransportSendResult> {
    if (!this.up) return { kind: 'UNAVAILABLE', reason: 'transport is down' };
    if (!this.peers.has(to_node_id)) return { kind: 'NO_PEER', reason: `${to_node_id} not in peer set` };

    // Deliver via the shared bus. We simulate async behavior with a microtask.
    await Promise.resolve();
    const ok = this.bus.deliver(this, to_node_id, bundle);
    if (!ok) return { kind: 'NO_PEER', reason: `${to_node_id} not registered on bus` };
    this.events.emit({
      name: 'bundle_forwarded',
      ts: Date.now(),
      transport_id: this.transport_id,
      bundle_id: bundle.bundle_id,
      peer_node_id: to_node_id,
    });
    return { kind: 'OK', forwarded_at: Date.now() };
  }

  onReceive(handler: (bundle: CommunicationBundle, from_node_id: string) => void): void {
    this.receivers.add(handler);
  }

  // ──────────────────────────────────────────────────────────────────────
  // P5: Capability gossip side-channel (ARCH-031).
  //
  // The Transport interface in core/transport/Transport.ts is UNCHANGED.
  // LoopbackTransport adds optional `gossip()` + `onGossip()` as a
  // duck-typed side-channel. The NodeRuntime casts transports to access
  // these — same pattern as `listReachablePeers` casts to access `peers`.
  //
  // Real edge transports (P4: Android BLE/Wi-Fi) MAY implement the same
  // methods; if they don't, gossip simply doesn't propagate over them.
  // ──────────────────────────────────────────────────────────────────────

  private gossipReceivers = new Set<(ad: any, from_node_id: string) => void>();

  /** Push a capability advertisement to all peers on this transport's bus. */
  gossip(advertisement: any): boolean {
    if (!this.up) return false;
    return this.bus.deliverGossip(this, advertisement);
  }

  /** Register a handler invoked when a capability advertisement arrives. */
  onGossip(handler: (ad: any, from_node_id: string) => void): void {
    this.gossipReceivers.add(handler);
  }

  /** Internal hook called by LoopbackBus when a gossip message arrives. */
  _ingestGossip(ad: any, from_node_id: string): void {
    for (const h of this.gossipReceivers) h(ad, from_node_id);
  }

  /** Internal hook called by LoopbackBus when a bundle arrives. */
  _ingest(bundle: CommunicationBundle, from_node_id: string): void {
    this.events.emit({
      name: 'bundle_received',
      ts: Date.now(),
      transport_id: this.transport_id,
      bundle_id: bundle.bundle_id,
      peer_node_id: from_node_id,
    });
    for (const r of this.receivers) r(bundle, from_node_id);
  }

  async close(): Promise<void> {
    this.up = false;
    this.bus.unregister(this);
  }
}

/**
 * Shared in-process bus that connects multiple LoopbackTransports.
 */
export class LoopbackBus {
  private nodes = new Map<string, LoopbackTransport>();

  register(t: LoopbackTransport): void {
    this.nodes.set(t.node_id, t);
  }

  unregister(t: LoopbackTransport): void {
    this.nodes.delete(t.node_id);
  }

  deliver(
    from: LoopbackTransport,
    to_node_id: string,
    bundle: CommunicationBundle,
  ): boolean {
    const dest = this.nodes.get(to_node_id);
    if (!dest) return false;
    dest._ingest(bundle, from.node_id);
    return true;
  }

  /**
   * P5: Deliver a capability advertisement to ALL peers on this bus
   * (except the sender). Gossip is broadcast, not point-to-point.
   */
  deliverGossip(from: LoopbackTransport, advertisement: any): boolean {
    let delivered = false;
    for (const [nodeId, dest] of this.nodes.entries()) {
      if (nodeId === from.node_id) continue; // don't echo back to sender
      dest._ingestGossip(advertisement, from.node_id);
      delivered = true;
    }
    return delivered;
  }

  list(): string[] {
    return Array.from(this.nodes.keys());
  }
}
