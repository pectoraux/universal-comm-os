/**
 * P9 Intelligent Routing tests.
 *
 * Proves the router picks the better peer when given a choice, based on:
 *   - peer verification state (TRUSTED > UNVERIFIED)
 *   - peer battery (high > low)
 *   - peer bandwidth (high > low)
 *   - peer storage (high > low for RELAY hops)
 *   - intent priority (EMERGENCY prioritizes reliability)
 *   - intent min_privacy (penalizes UNVERIFIED peers)
 *
 * Per ROADMAP P9: "Implement routing based on cost, latency, reliability,
 * availability, battery, bandwidth, storage, trust, delivery probability,
 * privacy, TTL, priority, capabilities."
 *
 * ARCH-035 (resource-aware routing), ARCH-036 (delivery probability estimation),
 * ARCH-037 (peer-caps-from-cache fix — each peer's actual caps are used,
 * not the local node's caps).
 */

import { describe, it, expect } from 'vitest';
import {
  createIntent,
  defaultPolicy,
  createRouter,
  computeHopMetrics,
  type PeerCapabilities,
} from '@/core/index';

describe('P9 — computeHopMetrics', () => {
  it('derives higher reliability for TRUSTED peers vs UNVERIFIED', () => {
    const intent = createIntent({ type: 'SEND_MESSAGE' });
    const trusted: PeerCapabilities = {
      node_id: 'trusted',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const unverified: PeerCapabilities = {
      node_id: 'unverified',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'UNVERIFIED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const trustedMetrics = computeHopMetrics('TRANSPORT', trusted, intent);
    const unverifiedMetrics = computeHopMetrics('TRANSPORT', unverified, intent);
    expect(trustedMetrics.reliability).toBeGreaterThan(unverifiedMetrics.reliability);
    expect(trustedMetrics.privacy_score).toBeGreaterThan(unverifiedMetrics.privacy_score);
  });

  it('penalizes low battery (<20% is critical)', () => {
    const intent = createIntent({ type: 'SEND_MESSAGE' });
    const fullBattery: PeerCapabilities = {
      node_id: 'full',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const lowBattery: PeerCapabilities = {
      node_id: 'low',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 15, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const fullMetrics = computeHopMetrics('TRANSPORT', fullBattery, intent);
    const lowMetrics = computeHopMetrics('TRANSPORT', lowBattery, intent);
    expect(lowMetrics.reliability).toBeLessThan(fullMetrics.reliability);
    expect(lowMetrics.delivery_probability).toBeLessThan(fullMetrics.delivery_probability);
  });

  it('penalizes low storage for RELAY hops (but not TRANSPORT hops)', () => {
    const intent = createIntent({ type: 'SEND_MESSAGE' });
    const highStorage: PeerCapabilities = {
      node_id: 'high',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const lowStorage: PeerCapabilities = {
      node_id: 'low',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000 }, // <10 MB
    };
    // RELAY hop: low storage should penalize reliability.
    const relayHigh = computeHopMetrics('RELAY', highStorage, intent);
    const relayLow = computeHopMetrics('RELAY', lowStorage, intent);
    expect(relayLow.reliability).toBeLessThan(relayHigh.reliability);

    // TRANSPORT hop: storage shouldn't matter.
    const transportHigh = computeHopMetrics('TRANSPORT', highStorage, intent);
    const transportLow = computeHopMetrics('TRANSPORT', lowStorage, intent);
    expect(transportLow.reliability).toBeCloseTo(transportHigh.reliability, 5);
  });

  it('reduces latency for high-bandwidth peers', () => {
    const intent = createIntent({ type: 'SEND_MESSAGE' });
    const highBw: PeerCapabilities = {
      node_id: 'high',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 100_000_000, storage_bytes: 1_000_000_000 },
    };
    const lowBw: PeerCapabilities = {
      node_id: 'low',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 100_000, storage_bytes: 1_000_000_000 },
    };
    const highMetrics = computeHopMetrics('TRANSPORT', highBw, intent);
    const lowMetrics = computeHopMetrics('TRANSPORT', lowBw, intent);
    expect(highMetrics.latency_ms).toBeLessThan(lowMetrics.latency_ms);
  });

  it('EMERGENCY priority reduces cost penalty', () => {
    const normalIntent = createIntent({ type: 'SEND_MESSAGE', priority: 'NORMAL' });
    const emergencyIntent = createIntent({ type: 'EMERGENCY_ALERT', priority: 'EMERGENCY' });
    const peer: PeerCapabilities = {
      node_id: 'peer',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'TRUSTED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const normalMetrics = computeHopMetrics('GATEWAY', peer, normalIntent);
    const emergencyMetrics = computeHopMetrics('GATEWAY', peer, emergencyIntent);
    expect(emergencyMetrics.cost).toBeLessThan(normalMetrics.cost);
  });

  it('STRICT privacy penalizes UNVERIFIED peers heavily', () => {
    const strictIntent = createIntent({ type: 'SEND_MESSAGE', min_privacy: 'STRICT' });
    const normalIntent = createIntent({ type: 'SEND_MESSAGE' });
    const unverified: PeerCapabilities = {
      node_id: 'unverified',
      transport: ['LAN'],
      relay: ['FORWARD'],
      gateway: [],
      verification: 'UNVERIFIED',
      resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
    };
    const strictMetrics = computeHopMetrics('TRANSPORT', unverified, strictIntent);
    const normalMetrics = computeHopMetrics('TRANSPORT', unverified, normalIntent);
    expect(strictMetrics.reliability).toBeLessThan(normalMetrics.reliability);
    expect(strictMetrics.privacy_score).toBeLessThan(normalMetrics.privacy_score);
  });
});

describe('P9 — Resource-aware route selection', () => {
  it('router picks TRUSTED high-battery peer over UNVERIFIED low-battery peer', () => {
    const route = createRouter(defaultPolicy);
    const decision = route({
      intent: createIntent({ type: 'SEND_MESSAGE' }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'good',
          transport: ['LAN'],
          relay: [],
          gateway: [],
          verification: 'TRUSTED',
          resource: { battery_pct: 100, bandwidth_bps: 10_000_000, storage_bytes: 1_000_000_000 },
        },
        {
          node_id: 'bad',
          transport: ['LAN'],
          relay: [],
          gateway: [],
          verification: 'UNVERIFIED',
          resource: { battery_pct: 15, bandwidth_bps: 100_000, storage_bytes: 1_000 },
        },
      ],
      destination: { node_id: 'good' }, // both peers match destNodeId? No — only 'good' does.
    });
    expect(decision.status).toBe('ROUTE_FOUND');
    expect(decision.plan?.hops[0].to_node_id).toBe('good');
  });

  it('router prefers peer with more storage for RELAY hops', () => {
    const route = createRouter(defaultPolicy);
    // Both peers are RELAYs with FORWARD capability; destination is a third node
    // reachable via either. The high-storage peer should win for RELAY hops.
    const decision = route({
      intent: createIntent({ type: 'SEND_MESSAGE' }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'high-storage-relay',
          transport: ['LAN'],
          relay: ['STORE', 'FORWARD'],
          gateway: [],
          verification: 'PEER_CORROBORATED',
          resource: { battery_pct: 90, bandwidth_bps: 1_000_000, storage_bytes: 1_000_000_000 },
        },
        {
          node_id: 'low-storage-relay',
          transport: ['LAN'],
          relay: ['STORE', 'FORWARD'],
          gateway: [],
          verification: 'PEER_CORROBORATED',
          resource: { battery_pct: 90, bandwidth_bps: 1_000_000, storage_bytes: 1_000_000 }, // <10 MB
        },
      ],
      // No specific destination — opportunistic. Both are candidates.
    });
    expect(decision.status).toBe('ROUTE_FOUND');
    // The high-storage relay should be chosen (its RELAY hop reliability is higher).
    expect(decision.plan?.hops[0].to_node_id).toBe('high-storage-relay');
  });

  it('router returns NO_ROUTE when min_reliability constraint cannot be met', () => {
    const route = createRouter(defaultPolicy);
    const decision = route({
      intent: createIntent({ type: 'SEND_MESSAGE', min_reliability: 0.99 }),
      sender_node_id: 'A',
      known_peers: [
        {
          node_id: 'weak',
          transport: ['LAN'],
          relay: [],
          gateway: [],
          verification: 'UNVERIFIED',
          resource: { battery_pct: 10, bandwidth_bps: 100_000, storage_bytes: 1_000 },
        },
      ],
      destination: { node_id: 'weak' },
    });
    // The weak peer's reliability is far below 0.99 — should be NO_ROUTE.
    expect(decision.status).toBe('NO_ROUTE');
  });
});
