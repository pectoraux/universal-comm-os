/**
 * Architecture boundary tests (Architecture Constitution Article I).
 *
 * We use a static AST-walker-free approach: import the core package and assert
 * that none of the forbidden cross-layer imports leak through the public surface.
 *
 * For a stricter version (filesystem scanning), see boundaries-strict.test.ts.
 */

import { describe, it, expect } from 'vitest';
import * as core from '@/core/index';

describe('Architecture: core public surface', () => {
  it('exports UniversalIdentity primitives', () => {
    expect(core.createUniversalIdentity).toBeDefined();
    expect(core.createChannelIdentity).toBeDefined();
    expect(core.generateIdentityKeyPair).toBeDefined();
  });

  it('exports Intent primitives', () => {
    expect(core.createIntent).toBeDefined();
    expect(core.isEmergency).toBeDefined();
  });

  it('exports CommunicationBundle primitives', () => {
    expect(core.createBundle).toBeDefined();
    expect(core.canonicalEnvelope).toBeDefined();
    expect(core.isExpired).toBeDefined();
    expect(core.appendProof).toBeDefined();
  });

  it('exports Conversation primitives', () => {
    expect(core.createConversation).toBeDefined();
  });

  it('exports Delivery state machine', () => {
    expect(core.createDeliveryTracker).toBeDefined();
    expect(core.canTransition).toBeDefined();
  });

  it('exports Capabilities primitives', () => {
    expect(core.advertiseCapabilities).toBeDefined();
    expect(core.deriveRoles).toBeDefined();
    expect(core.isGateway).toBeDefined();
    expect(core.canStore).toBeDefined();
    expect(core.canForward).toBeDefined();
  });

  it('exports Policy primitives', () => {
    expect(core.createRoutingPolicy).toBeDefined();
    expect(core.defaultPolicy).toBeDefined();
  });

  it('exports Trust (cryptographic envelope)', () => {
    expect(core.sealPayload).toBeDefined();
    expect(core.openSealedPayload).toBeDefined();
    expect(core.signProof).toBeDefined();
    expect(core.verifyProof).toBeDefined();
  });

  it('exports Router', () => {
    expect(core.createRouter).toBeDefined();
  });

  it('exports Transport interface (interface-only — no impl)', () => {
    // Transport is a type, so it's not a runtime export; we just verify
    // that we did not accidentally pull in a LoopbackTransport here.
    expect((core as any).LoopbackTransport).toBeUndefined();
  });

  it('exports ChannelAdapter interface (interface-only — no impl)', () => {
    expect((core as any).EmailAdapter).toBeUndefined();
    expect((core as any).WhatsappAdapter).toBeUndefined();
  });
});

describe('Architecture: delivery state machine legality', () => {
  it('forbids `sent=true` as a delivery state', () => {
    const tracker = core.createDeliveryTracker();
    tracker.init('b1');
    // We must NOT see "sent=true" anywhere in the public API or state machine.
    const states = tracker.snapshot().map((r) => r.current);
    for (const s of states) {
      expect((s as string).toLowerCase()).not.toBe('sent');
    }
  });

  it('rejects illegal forward transitions', () => {
    const tracker = core.createDeliveryTracker();
    tracker.init('b2');
    // CREATED -> READ directly is illegal.
    expect(() => tracker.transition('b2', 'READ')).toThrow();
  });

  it('accepts legal forward transitions', () => {
    const tracker = core.createDeliveryTracker();
    tracker.init('b3');
    expect(() => tracker.transition('b3', 'ACCEPTED')).not.toThrow();
    expect(() => tracker.transition('b3', 'QUEUED')).not.toThrow();
    expect(() => tracker.transition('b3', 'RELAYED')).not.toThrow();
    expect(() => tracker.transition('b3', 'DELIVERED')).not.toThrow();
    expect(() => tracker.transition('b3', 'READ')).not.toThrow();
  });

  it('treats failure states as terminal', () => {
    const tracker = core.createDeliveryTracker();
    tracker.init('b4');
    expect(() => tracker.transition('b4', 'NO_ROUTE')).not.toThrow();
    // After NO_ROUTE, no further transition is allowed.
    expect(() => tracker.transition('b4', 'RELAYED')).toThrow();
  });
});

describe('Architecture: capability-based routing (not device types)', () => {
  it('routes over BLE capability, never over device_type', () => {
    const route = core.createRouter(core.defaultPolicy);
    const decision = route({
      intent: core.createIntent({ type: 'SEND_MESSAGE' }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'B',
          transport: ['BLE'],
          relay: ['FORWARD'],
          gateway: [],
          verification: 'UNVERIFIED',
        },
      ],
      destination: { node_id: 'B' },
    });
    expect(decision.status).toBe('ROUTE_FOUND');
    expect(decision.plan?.hops[0].transport).toBe('BLE');
  });

  it('returns NO_ROUTE when no peer satisfies intent constraints', () => {
    const route = core.createRouter(core.defaultPolicy);
    const decision = route({
      intent: core.createIntent({ type: 'SEND_MESSAGE', min_reliability: 0.99 }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'B',
          transport: ['BLE'],
          relay: ['FORWARD'],
          gateway: [],
          verification: 'UNVERIFIED',
        },
      ],
      destination: { node_id: 'B' },
    });
    expect(decision.status).toBe('NO_ROUTE');
  });
});
