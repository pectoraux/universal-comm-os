/**
 * server/android/TransportRegistry.ts — P4.1
 *
 * Registry for transport implementations against the existing `Transport`
 * interface (src/core/transport/Transport.ts). P4.1 prepares for later
 * transport adapters (BLE, Wi-Fi Direct) by providing this registry.
 * P4.1 does NOT implement BLE or Wi-Fi Direct.
 *
 * Article XVIII §1 (Hardware adapters implement the Transport interface):
 *   Every transport registered here MUST implement the canonical
 *   `Transport` interface. The registry refuses to register transports
 *   that don't conform.
 *
 * Article XVIII §2 (no exceptions across the boundary):
 *   Transport.send() returns TransportSendResult, never throws. The
 *   registry does not add any wrapping that could throw.
 *
 * P4 design §12 — Transport Readiness:
 *   The runtime can register/unregister transport implementations
 *   against the existing Transport abstraction.
 *
 * Article XVIII §5 (transports live in src/transport/<name>/):
 *   The actual BLE/Wi-Fi Direct adapters will live in
 *   `src/transport/ble/` and `src/transport/wifidirect/` when P4.2/P4.3
 *   ship. P4.1 only provides the registry.
 */

import type { Transport, TransportSendResult } from '@/core/transport/Transport';
import type { CommunicationBundle } from '@/core/bundle/types';
import type { TransportCapabilityType } from '@/core/capabilities/types';

/**
 * A transport registration entry. The runtime uses this to dispatch
 * bundles over a specific transport.
 */
export interface RegisteredTransportEntry {
  readonly transport: Transport;
  readonly registered_at: number;
}

/**
 * The TransportRegistry. Holds transports keyed by `transport_id`.
 *
 * Conforms to Article XVIII:
 *   - The registry does NOT mutate transports.
 *   - The registry does NOT decrypt bundles.
 *   - The registry does NOT change delivery state (that's DeliveryTracker).
 *   - The registry does NOT throw (register/unregister return booleans).
 */
export class TransportRegistry {
  private readonly transports: Map<string, RegisteredTransportEntry> = new Map();

  /**
   * Register a transport. Returns true on success, false if a transport
   * with the same `transport_id` is already registered (caller should
   * unregister first).
   *
   * The registry validates that the transport conforms to the `Transport`
   * interface (has the 4 required methods). Non-conforming transports
   * are refused.
   */
  register(transport: Transport): boolean {
    // Article XVIII §1 — validate the Transport interface.
    if (typeof transport.transport_id !== 'string' || transport.transport_id === '') {
      return false;
    }
    if (typeof transport.transport_type !== 'string') {
      return false;
    }
    if (typeof transport.isAvailable !== 'function') {
      return false;
    }
    if (typeof transport.send !== 'function') {
      return false;
    }
    if (typeof transport.onReceive !== 'function') {
      return false;
    }
    if (this.transports.has(transport.transport_id)) {
      return false; // already registered
    }
    this.transports.set(transport.transport_id, {
      transport,
      registered_at: Date.now(),
    });
    return true;
  }

  /**
   * Unregister a transport. Returns true if the transport was registered
   * and has been removed; false otherwise.
   *
   * Calls transport.close() (if defined) to allow graceful shutdown
   * (Article XVIII §2 — close is part of the Transport interface).
   */
  async unregister(transport_id: string): Promise<boolean> {
    const entry = this.transports.get(transport_id);
    if (!entry) return false;
    // R5 callback ownership — call close() to release transport resources.
    if (typeof entry.transport.close === 'function') {
      try {
        await entry.transport.close();
      } catch {
        // Article XVIII §2 — transports MUST NOT throw across the boundary.
        // We catch and ignore. The transport is still unregistered.
      }
    }
    this.transports.delete(transport_id);
    return true;
  }

  /** Get a registered transport by ID. */
  get(transport_id: string): Transport | undefined {
    return this.transports.get(transport_id)?.transport;
  }

  /** List all registered transports. */
  list(): Transport[] {
    return Array.from(this.transports.values()).map((e) => e.transport);
  }

  /** List transports of a specific type (e.g., 'BLE', 'WIFI'). */
  listByType(type: TransportCapabilityType): Transport[] {
    return this.list().filter((t) => t.transport_type === type);
  }

  /** The number of registered transports. */
  size(): number {
    return this.transports.size;
  }

  /**
   * Send a bundle over a specific transport. Returns the
   * TransportSendResult — never throws (Article XVIII §2).
   *
   * If the transport is not registered, returns
   * `{ kind: 'UNAVAILABLE'; reason: 'transport not registered' }`.
   */
  async send(
    transport_id: string,
    bundle: CommunicationBundle,
    to_node_id: string,
  ): Promise<TransportSendResult> {
    const transport = this.get(transport_id);
    if (!transport) {
      return { kind: 'UNAVAILABLE', reason: `transport ${transport_id} not registered` };
    }
    // Article XVIII §2 — catch any unexpected throw from the transport
    // and translate to ERROR. (Defensive — transports shouldn't throw.)
    try {
      return await transport.send(bundle, to_node_id);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { kind: 'ERROR', reason: `transport threw: ${reason}` };
    }
  }

  /** Unregister all transports (for runtime shutdown — R5). */
  async close(): Promise<void> {
    const transport_ids = Array.from(this.transports.keys());
    for (const id of transport_ids) {
      await this.unregister(id);
    }
  }
}
