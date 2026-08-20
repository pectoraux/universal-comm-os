/**
 * core/transport/TransportEvent.ts
 *
 * Lightweight event emitter used by the runtime to observe transport + delivery events.
 * Per THREAT_MODEL §11 (Observability): MUST NOT expose private message contents or
 * sensitive metadata.
 */

export type TransportEventName =
  | 'bundle_received'
  | 'bundle_forwarded'
  | 'bundle_dropped'
  | 'transport_up'
  | 'transport_down';

export interface TransportEvent {
  readonly name: TransportEventName;
  readonly ts: number;
  readonly transport_id?: string;
  readonly bundle_id?: string; // OK to expose; opaque id, no payload
  readonly peer_node_id?: string;
  readonly note?: string;
}

export interface TransportEventSink {
  emit(event: TransportEvent): void;
  subscribe(handler: (e: TransportEvent) => void): () => void;
}

export function createTransportEventSink(): TransportEventSink {
  const handlers = new Set<(e: TransportEvent) => void>();
  return {
    emit(event) {
      for (const h of handlers) h(event);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
