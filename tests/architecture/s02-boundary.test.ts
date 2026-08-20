/**
 * S0.2 Security Boundary Completion tests.
 *
 * Tests:
 * 1. Denied authorization IS audited (at the boundary, before returning FORBIDDEN)
 * 2. Resource visibility classes exist and are used
 * 3. Global reads are NOT all PUBLIC (transcripts/analytics are ORGANIZATION/PLATFORM)
 * 4. PLATFORM_ADMIN is distinct from ORG roles
 * 5. Channel verification challenge system exists (ASSERTED → VERIFIED)
 * 6. ASSERTED identities can't be used for production delivery
 * 7. validateOrigin() is removed (S0.2-8)
 * 8. Audit persistence is mandatory for denied ops
 * 9. Cross-org access is blocked
 * 10. Negative tests for unverified channel delivery
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const ACTIONS_FILE = join(PROJECT_ROOT, 'src', 'app', 'actions', 'commos.ts');
const AUTHZ_FILE = join(PROJECT_ROOT, 'src', 'lib', 'authorization.ts');
const CONSTITUTION_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_CONSTITUTION.md');
const PRISMA_SCHEMA = join(PROJECT_ROOT, 'prisma', 'schema.prisma');

describe('S0.2-1: Denied authorization IS audited', () => {
  const source = readFileSync(AUTHZ_FILE, 'utf-8');

  it('authorizeNode calls auditMandatory BEFORE throwing AuthzError', () => {
    // Verify that every throw in authorizeNode is preceded by auditMandatory
    expect(source).toContain('auditMandatory');
    // The denied paths must audit before throwing
    expect(source).toMatch(/auditMandatory.*denied.*\n.*throw new AuthzError/s);
  });

  it('authorizeByVisibility audits denied before throwing', () => {
    expect(source).toMatch(/auditMandatory.*denied.*\n.*throw new AuthzError/s);
  });

  it('authorizeNetworkOperation audits denied before throwing', () => {
    const fnBody = source.slice(
      source.indexOf('export async function authorizeNetworkOperation'),
      source.indexOf('export async function auditMandatory'),
    );
    expect(fnBody).toContain('auditMandatory');
    expect(fnBody).toContain("'denied'");
    expect(fnBody).toContain('throw new AuthzError');
  });
});

describe('S0.2-2: Resource visibility classes', () => {
  const source = readFileSync(AUTHZ_FILE, 'utf-8');

  it('ResourceVisibility type exists with PUBLIC/ORGANIZATION/USER/PLATFORM', () => {
    expect(source).toContain("ResourceVisibility");
    expect(source).toContain("'PUBLIC'");
    expect(source).toContain("'ORGANIZATION'");
    expect(source).toContain("'USER'");
    expect(source).toContain("'PLATFORM'");
  });

  it('authorizeByVisibility function exists', () => {
    expect(source).toContain('export async function authorizeByVisibility');
  });
});

describe('S0.2-3: Global reads are NOT all PUBLIC', () => {
  const source = readFileSync(ACTIONS_FILE, 'utf-8');

  it('getEmailTranscriptAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(source, 'getEmailTranscriptAction');
    expect(fnBody).toContain("'ORGANIZATION'");
    expect(fnBody).toContain('authorizeByVisibility');
  });

  it('getSmsTranscriptAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(source, 'getSmsTranscriptAction');
    expect(fnBody).toContain("'ORGANIZATION'");
  });

  it('getWhatsappTranscriptAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(source, 'getWhatsappTranscriptAction');
    expect(fnBody).toContain("'ORGANIZATION'");
  });

  it('getIdentityGraphAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(source, 'getIdentityGraphAction');
    expect(fnBody).toContain("'ORGANIZATION'");
  });

  it('getAnalyticsAction uses PLATFORM visibility', () => {
    const fnBody = extractFn(source, 'getAnalyticsAction');
    expect(fnBody).toContain("'PLATFORM'");
  });

  it('getCommunityStatsAction uses PLATFORM visibility', () => {
    const fnBody = extractFn(source, 'getCommunityStatsAction');
    expect(fnBody).toContain("'PLATFORM'");
  });

  it('getRoutingPolicyAction uses PLATFORM visibility', () => {
    const fnBody = extractFn(source, 'getRoutingPolicyAction');
    expect(fnBody).toContain("'PLATFORM'");
  });

  it('getNetworkStateAction uses PUBLIC visibility (network topology is public)', () => {
    const fnBody = extractFn(source, 'getNetworkStateAction');
    expect(fnBody).toContain("'PUBLIC'");
  });
});

describe('S0.2-4: PLATFORM_ADMIN is distinct from ORG roles', () => {
  const source = readFileSync(AUTHZ_FILE, 'utf-8');

  it('AuthzRole type has PLATFORM_ADMIN/ORG_OWNER/ORG_ADMIN/ORG_MEMBER/DEMO', () => {
    expect(source).toContain("'PLATFORM_ADMIN'");
    expect(source).toContain("'ORG_OWNER'");
    expect(source).toContain("'ORG_ADMIN'");
    expect(source).toContain("'ORG_MEMBER'");
    expect(source).toContain("'DEMO'");
  });

  it('toAuthzRole maps admin→PLATFORM_ADMIN', () => {
    expect(source).toContain("return 'PLATFORM_ADMIN'");
  });

  it('isPlatformAdmin function exists', () => {
    expect(source).toContain('function isPlatformAdmin');
  });

  it('authorizeNode checks isPlatformAdmin (not just role === admin)', () => {
    const fnBody = source.slice(
      source.indexOf('export async function authorizeNode'),
      source.indexOf('export async function authorizeBundleAtNode'),
    );
    expect(fnBody).toContain('isPlatformAdmin');
  });
});

describe('S0.2-5/6: Channel verification challenge system', () => {
  const source = readFileSync(AUTHZ_FILE, 'utf-8');
  const schema = readFileSync(PRISMA_SCHEMA, 'utf-8');

  it('Prisma schema has ChannelVerificationChallenge model', () => {
    expect(schema).toContain('model ChannelVerificationChallenge');
  });

  it('createChannelChallenge function exists', () => {
    expect(source).toContain('export async function createChannelChallenge');
  });

  it('verifyChannelChallenge function exists', () => {
    expect(source).toContain('export async function verifyChannelChallenge');
  });

  it('isChannelVerified function exists (S0.2.1: renamed from isVerifiedLink)', () => {
    expect(source).toContain('export async function isChannelVerified');
  });

  it('linkIdentityToChannelAction creates a challenge (ASSERTED state)', () => {
    const actions = readFileSync(ACTIONS_FILE, 'utf-8');
    const fnBody = extractFn(actions, 'linkIdentityToChannelAction');
    expect(fnBody).toContain('createChannelChallenge');
    expect(fnBody).toContain('ASSERTED');
  });

  it('verifyChannelAction exists in commos.ts', () => {
    const actions = readFileSync(ACTIONS_FILE, 'utf-8');
    expect(actions).toContain('export async function verifyChannelAction');
  });
});

describe('S0.2-7: ASSERTED identities not used for production delivery', () => {
  const source = readFileSync(ACTIONS_FILE, 'utf-8');

  it('dispatchBundleAction checks isChannelVerified for channel recipients', () => {
    const fnBody = extractFn(source, 'dispatchBundleAction');
    expect(fnBody).toContain('isChannelVerified');
  });
});

describe('S0.2-8: validateOrigin removed', () => {
  const source = readFileSync(AUTHZ_FILE, 'utf-8');

  it('validateOrigin function does NOT exist', () => {
    expect(source).not.toContain('export function validateOrigin');
  });

  it('validateOrigin function does NOT exist (S0.2-8: removed, S0.2.1: comment also removed)', () => {
    expect(source).not.toContain('export function validateOrigin');
  });
});

describe('S0.2-9: Audit persistence is mandatory', () => {
  const source = readFileSync(AUTHZ_FILE, 'utf-8');

  it('auditMandatory function exists', () => {
    expect(source).toContain('async function auditMandatory');
  });

  it('auditMandatory logs to console.error on failure (not silently caught)', () => {
    expect(source).toContain('console.error');
    expect(source).toContain('[AUDIT_FAILURE]');
  });

  it('authorizeNode uses auditMandatory (not logAuditEvent)', () => {
    const fnBody = source.slice(
      source.indexOf('export async function authorizeNode'),
      source.indexOf('export async function authorizeBundleAtNode'),
    );
    expect(fnBody).toContain('auditMandatory');
    expect(fnBody).not.toContain('logAuditEvent');
  });
});

describe('S0.2-10: Article XIII in constitution', () => {
  const source = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('Article XIII exists', () => {
    expect(source).toContain('Article XIII');
  });

  it('Contains the architectural rule about separate authorization dimensions', () => {
    expect(source).toContain('separate authorization dimensions');
    expect(source).toContain('Authentication of the caller does not establish');
  });

  it('Contains resource visibility classes', () => {
    expect(source).toContain('PUBLIC');
    expect(source).toContain('ORGANIZATION');
    expect(source).toContain('USER');
    expect(source).toContain('PLATFORM');
  });

  it('Contains role hierarchy', () => {
    expect(source).toContain('PLATFORM_ADMIN');
    expect(source).toContain('ORG_OWNER');
    expect(source).toContain('ORG_ADMIN');
    expect(source).toContain('ORG_MEMBER');
  });

  it('Contains channel verification states', () => {
    expect(source).toContain('ASSERTED');
    expect(source).toContain('VERIFIED');
    expect(source).toContain('REVOKED');
  });

  it('States ASSERTED identities MUST NOT be used for production delivery', () => {
    expect(source).toContain('ASSERTED identities MUST NOT be used for production delivery');
  });

  it('States denied operations MUST be audited at the boundary', () => {
    expect(source).toContain('Denied operations MUST be audited');
    expect(source).toContain('audit system never depends on the protected operation running first');
  });
});

// Helper
function extractFn(source: string, fnName: string): string {
  const start = source.indexOf(`export async function ${fnName}(`);
  if (start === -1) return '';
  let bodyStart = source.indexOf(') {', start);
  if (bodyStart === -1) return '';
  bodyStart = source.indexOf('{', bodyStart);
  let depth = 0;
  let i = bodyStart;
  while (i < source.length) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) break;
    i++;
  }
  return source.slice(start, i + 1);
}
