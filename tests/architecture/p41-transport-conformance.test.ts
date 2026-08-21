/**
 * tests/architecture/p41-transport-conformance.test.ts — P4.1
 *
 * Runs the TransportConformanceSuite against the FakeTransport factory.
 * P4.1 proves the suite itself works. P4.2/P4.3 will register their
 * own factories and the same suite will prove BLE/Wi-Fi Direct conformance.
 *
 * Article XVIII §14 — a conformance suite failure is an architecture-control
 * defect.
 */

import { describe, it, expect } from 'vitest';
import { runTransportConformanceSuite, fakeTransportFactory } from '@/server/android/conformance/TransportConformanceSuite';

// Run the canonical conformance suite against the FakeTransport factory.
// This proves the suite itself works (P4.1). P4.2/P4.3 will add
// `runTransportConformanceSuite(bleTransportFactory, 'BLE')` and
// `runTransportConformanceSuite(wifiDirectTransportFactory, 'WiFiDirect')`.
runTransportConformanceSuite(fakeTransportFactory, 'FakeTransport');

// Additional direct tests of the FakeTransport itself.
describe('P4.1 — FakeTransport direct tests', () => {
  it('is explicitly a test fixture (Fake prefix)', async () => {
    const { transport, close } = fakeTransportFactory({
      node_id: 'test',
      transport_type: 'BLE',
      peer_node_ids: [],
    });
    expect(transport.transport_id).toContain('fake:');
    await close();
  });

  it('never throws (Article XVIII §2 — no exceptions across boundary)', async () => {
    const { transport, close } = fakeTransportFactory({
      node_id: 'test',
      transport_type: 'BLE',
      peer_node_ids: [],
    });
    // Sending to a non-existent peer returns NO_PEER (not a throw).
    const result = await transport.send({} as any, 'nobody');
    expect(result.kind).toBe('NO_PEER');
    // Sending while unavailable returns UNAVAILABLE (not a throw).
    if (transport.close) await transport.close();
    const result2 = await transport.send({} as any, 'nobody');
    expect(result2.kind).toBe('UNAVAILABLE');
    await close();
  });

  it('uses only the 4 canonical TransportSendResult kinds', async () => {
    const { transport, close } = fakeTransportFactory({
      node_id: 'test',
      transport_type: 'BLE',
      peer_node_ids: ['peer1'],
    });
    const result = await transport.send({} as any, 'peer1');
    expect(['OK', 'UNAVAILABLE', 'NO_PEER', 'ERROR']).toContain(result.kind);
    await close();
  });
});
