/**
 * core/index.ts — public surface of the canonical protocol.
 *
 * Layer: CORE (Architecture Constitution Article I).
 *
 * This module MUST NOT import from:
 *   @/adapters/*  (channel adapters)
 *   @/matrix/*    (Matrix fabric)
 *   @/transport/* (transport implementations — the Transport INTERFACE lives in core/transport)
 *   @/components/*  @/app/*  @/hooks/*  (UI)
 *   next  react  @prisma/client
 *
 * Violations are enforced by tests/architecture/boundaries.test.ts.
 */

// Identity
export * from './identity/types';
export * from './identity/UniversalIdentity';
export * from './identity/ChannelIdentity';
export * from './identity/keys';

// Intent
export * from './intent/types';
export * from './intent/Intent';

// Bundle
export * from './bundle/types';
export * from './bundle/CommunicationBundle';

// Conversation
export * from './conversation/Conversation';

// Delivery
export * from './delivery/types';
export * from './delivery/DeliveryTracker';

// Capabilities
export * from './capabilities/types';
export * from './capabilities/NodeCapabilities';
export * from './capabilities/CapabilityCache';

// Policy
export * from './policy/types';
export * from './policy/RoutingPolicy';

// Trust (cryptographic envelope)
export * from './trust/CryptoEnvelope';
export * from './trust/Proof';

// Routing
export * from './routing/types';
export * from './routing/Router';

// Transport (interface ONLY — implementations live in src/transport/*)
export * from './transport/Transport';
export * from './transport/TransportEvent';

// Adapter (interface ONLY — implementations live in src/adapters/*)
export * from './adapters/ChannelAdapter';

// Errors
export * from './errors';

// Util (encoding helpers, also safe for outer layers)
export * from './util/encoding';
