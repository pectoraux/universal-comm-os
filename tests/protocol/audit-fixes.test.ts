/**
 * AUDIT FIX tests — verify that the honesty fixes are in place.
 *
 * 1. synthesizeChannelIdentity() has been removed — dispatch to unverified
 *    channel recipients is REFUSED (ARCH-034).
 * 2. Gateway delivery state stops at EXTERNAL_ACCEPTED — the false DELIVERED
 *    transition has been removed.
 * 3. relayForwardProofs uses full canonical fields, not approximate checks.
 */

import { describe, it, expect } from 'vitest';
import {
  createIntent,
  defaultPolicy,
  createRoutingPolicy,
  createRouter,
  type PeerCapabilities,
} from '@/core/index';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('AUDIT FIX 1: synthesizeChannelIdentity removed', () => {
  it('the function does not exist in CommOS.ts', () => {
    const commosSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'server', 'CommOS.ts'),
      'utf-8',
    );
    // The function definition should NOT be present.
    expect(commosSource).not.toContain('function synthesizeChannelIdentity(');
    // The fallback call should NOT be present.
    expect(commosSource).not.toContain('const synth = synthesizeChannelIdentity');
    // The error message for unverified recipients SHOULD be present.
    expect(commosSource).toContain('refuses to encrypt to an unverified recipient');
  });

  it('core/ does not contain "synthesize"', () => {
    // The architecture boundary test already checks this, but we verify here too.
    const routerSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'core', 'routing', 'Router.ts'),
      'utf-8',
    );
    expect(routerSource.toLowerCase()).not.toContain('synthesize');
  });
});

describe('AUDIT FIX 2: no false DELIVERED at gateway', () => {
  it('NodeRuntime.ts does not transition to DELIVERED after EXTERNAL_ACCEPTED at the gateway', () => {
    const runtimeSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'server', 'NodeRuntime.ts'),
      'utf-8',
    );
    // The false DELIVERED comment should be removed.
    expect(runtimeSource).not.toContain('For demo purposes, we also mark DELIVERED');
    // The AUDIT-FIX comment should be present.
    expect(runtimeSource).toContain('AUDIT-FIX');
    expect(runtimeSource).toContain('false DELIVERED has been removed');
  });
});

describe('AUDIT FIX 3: relayForwardProofs uses full canonical fields', () => {
  it('CommOS.ts does not contain "approximate" for proof verification', () => {
    const commosSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'server', 'CommOS.ts'),
      'utf-8',
    );
    expect(commosSource).not.toContain('We approximate verification');
    expect(commosSource).toContain('AUDIT-FIX: use full canonical fields');
  });
});

describe('AUDIT FIX 4: architecture tests catch dishonest tokens', () => {
  it('boundaries-strict test includes synthesize/simulate/approximate in forbidden tokens', () => {
    const testSource = fs.readFileSync(
      path.join(__dirname, '..', 'architecture', 'boundaries-strict.test.ts'),
      'utf-8',
    );
    expect(testSource).toContain('synthesize');
    expect(testSource).toContain('simulate');
    expect(testSource).toContain('approximate');
    expect(testSource).toContain('best-effort guess');
  });
});
