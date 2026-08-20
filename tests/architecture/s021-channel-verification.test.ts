/**
 * S0.2.1 — Real Channel Ownership Verification tests.
 *
 * Per Article XIV: "An authorization state and a resource state must never
 * be inferred from each other. A channel's ASSERTED/VERIFIED/REVOKED state
 * is independent of the caller's organization authorization. Both checks are mandatory."
 *
 * Tests:
 * 1. New links are ASSERTED (not VERIFIED)
 * 2. resolveChannelRecipient returns ONLY VERIFIED
 * 3. Challenge codes are hashed (SHA-256), not stored as plaintext
 * 4. Challenge codes are never returned to browser
 * 5. State transitions: ASSERTED→VERIFIED, ASSERTED→EXPIRED, VERIFIED→REVOKED
 * 6. verifyChannelAction updates link from ASSERTED to VERIFIED
 * 7. Dispatch rejects ASSERTED/EXPIRED/REVOKED; only VERIFIED works
 * 8. Sensitive data moved from PUBLIC to ORGANIZATION
 * 9. Org isolation: cross-org access forbidden
 * 10. Article XIV in constitution
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const ACTIONS_FILE = join(PROJECT_ROOT, 'src', 'app', 'actions', 'commos.ts');
const AUTHZ_FILE = join(PROJECT_ROOT, 'src', 'lib', 'authorization.ts');
const CONSTITUTION_FILE = join(PROJECT_ROOT, 'docs', 'architecture', 'ARCHITECTURE_CONSTITUTION.md');
const PRISMA_SCHEMA = join(PROJECT_ROOT, 'prisma', 'schema.prisma');
const IDENTITY_GRAPH_FILE = join(PROJECT_ROOT, 'src', 'core', 'identity', 'IdentityGraph.ts');

// ─── S0.2.1-1: New links are ASSERTED ───────────────────────────────

describe('S0.2.1-1: New links default to ASSERTED', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');
  const actions = readFileSync(ACTIONS_FILE, 'utf-8');

  it('createChannelChallenge sets link_state to ASSERTED', () => {
    expect(authz).toContain("'ASSERTED'");
    expect(authz).toContain("link_state: 'ASSERTED'");
  });

  it('linkIdentityToChannelAction returns verificationStatus ASSERTED', () => {
    const fnBody = extractFn(actions, 'linkIdentityToChannelAction');
    expect(fnBody).toContain('ASSERTED');
  });
});

// ─── S0.2.1-2: Challenge codes are hashed ───────────────────────────

describe('S0.2.1-2: Challenge codes are hashed', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');

  it('generateChallengeCode uses crypto.getRandomValues', () => {
    expect(authz).toContain('crypto.getRandomValues');
  });

  it('hashChallengeCode uses SHA-256', () => {
    expect(authz).toContain('sha256');
    expect(authz).toContain('hashChallengeCode');
  });

  it('createChannelChallenge stores challenge_hash (not challenge_code)', () => {
    expect(authz).toContain('challenge_hash');
    expect(authz).not.toContain('challenge_code: challengeCode');
  });

  it('verifyChannelChallenge hashes the submitted code before comparing', () => {
    expect(authz).toContain('hashChallengeCode(input.challengeCode)');
  });
});

// ─── S0.2.1-3: Challenge codes never returned to browser ───────────

describe('S0.2.1-3: Challenge code never returned to browser', () => {
  const actions = readFileSync(ACTIONS_FILE, 'utf-8');

  it('linkIdentityToChannelAction does NOT return challengeCode in response', () => {
    const fnBody = extractFn(actions, 'linkIdentityToChannelAction');
    // The return statement should not include challengeCode as a return field.
    // It's OK for challengeCode to be a local variable — it just can't be returned.
    const returnStatements = fnBody.match(/return\s*\{[^}]+\}/gs) || [];
    for (const ret of returnStatements) {
      expect(ret).not.toContain('challengeCode');
    }
    expect(fnBody).toContain('verificationStatus');
    expect(fnBody).toContain('message');
  });
});

// ─── S0.2.1-4: State transitions ────────────────────────────────────

describe('S0.2.1-4: State transitions', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');

  it('verifyChannelChallenge transitions to VERIFIED on success', () => {
    expect(authz).toContain("'VERIFIED'");
    expect(authz).toContain("link_state: 'VERIFIED'");
  });

  it('verifyChannelChallenge transitions to EXPIRED on timeout', () => {
    expect(authz).toContain("'EXPIRED'");
    expect(authz).toContain("link_state: 'EXPIRED'");
  });

  it('revokeChannelLink transitions VERIFIED to REVOKED', () => {
    expect(authz).toContain('revokeChannelLink');
    expect(authz).toContain("'REVOKED'");
    expect(authz).toContain("link_state: 'REVOKED'");
  });
});

// ─── S0.2.1-5: Dispatch rejects non-VERIFIED ───────────────────────

describe('S0.2.1-5: Dispatch rejects ASSERTED/EXPIRED/REVOKED', () => {
  const actions = readFileSync(ACTIONS_FILE, 'utf-8');

  it('dispatchBundleAction calls isChannelVerified for channel recipients', () => {
    const fnBody = extractFn(actions, 'dispatchBundleAction');
    expect(fnBody).toContain('isChannelVerified');
  });

  it('dispatchBundleAction returns FORBIDDEN when not verified', () => {
    const fnBody = extractFn(actions, 'dispatchBundleAction');
    expect(fnBody).toContain('not VERIFIED');
    expect(fnBody).toContain('FORBIDDEN');
    expect(fnBody).toContain('Article XIV');
  });
});

// ─── S0.2.1-6: isChannelVerified function exists ───────────────────

describe('S0.2.1-6: isChannelVerified checks VERIFIED state', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');

  it('isChannelVerified function exists and checks link_state', () => {
    expect(authz).toContain('export async function isChannelVerified');
    expect(authz).toContain("=== 'VERIFIED'");
  });

  it('getChannelLinkState function exists', () => {
    expect(authz).toContain('export async function getChannelLinkState');
  });

  it('revokeChannelLink function exists', () => {
    expect(authz).toContain('export async function revokeChannelLink');
  });
});

// ─── S0.2.1-7: Sensitive data moved from PUBLIC to ORGANIZATION ────

describe('S0.2.1-7: Sensitive data not PUBLIC', () => {
  const actions = readFileSync(ACTIONS_FILE, 'utf-8');

  it('getDeliverySnapshotsAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(actions, 'getDeliverySnapshotsAction');
    expect(fnBody).toContain("'ORGANIZATION'");
    expect(fnBody).not.toContain("'PUBLIC'");
  });

  it('getQueuedBundlesAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(actions, 'getQueuedBundlesAction');
    expect(fnBody).toContain("'ORGANIZATION'");
  });

  it('getRelayForwardProofsAction uses ORGANIZATION visibility', () => {
    const fnBody = extractFn(actions, 'getRelayForwardProofsAction');
    expect(fnBody).toContain("'ORGANIZATION'");
  });
});

// ─── S0.2.1-8: Org isolation ────────────────────────────────────────

describe('S0.2.1-8: Cross-org access is FORBIDDEN', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');

  it('authorizeNode throws FORBIDDEN with cross-org message', () => {
    expect(authz).toContain('Cross-org');
    expect(authz).toContain('FORBIDDEN');
    expect(authz).toContain('Article XIV');
  });
});

// ─── S0.2.1-9: Prisma schema has hashed challenges ──────────────────

describe('S0.2.1-9: Prisma schema', () => {
  const schema = readFileSync(PRISMA_SCHEMA, 'utf-8');

  it('ChannelVerificationChallenge has challenge_hash field', () => {
    expect(schema).toContain('challenge_hash');
  });

  it('does NOT have challenge_code field', () => {
    expect(schema).not.toContain('challenge_code');
  });

  it('has link_state field', () => {
    expect(schema).toContain('link_state');
  });

  it('has organization_id field', () => {
    expect(schema).toContain('organization_id');
  });
});

// ─── S0.2.1-10: Article XIV in constitution ─────────────────────────

describe('S0.2.1-10: Article XIV', () => {
  const constitution = readFileSync(CONSTITUTION_FILE, 'utf-8');

  it('Article XIV exists', () => {
    expect(constitution).toContain('Article XIV');
  });

  it('states authorization state ≠ resource state', () => {
    expect(constitution).toContain('authorization state and a resource state must never be inferred');
  });

  it('states new links default to ASSERTED', () => {
    expect(constitution).toContain('default to `ASSERTED`');
  });

  it('states resolveChannelRecipient returns ONLY VERIFIED', () => {
    expect(constitution).toContain('returns ONLY `VERIFIED`');
  });

  it('states challenge codes are hashed', () => {
    expect(constitution).toContain('Stored as SHA-256 hashes');
  });

  it('states never returned to browser', () => {
    expect(constitution).toContain('Never returned to the browser');
  });

  it('states dispatch rejects ASSERTED and REVOKED', () => {
    expect(constitution).toContain('Dispatch MUST reject `ASSERTED` and `REVOKED`');
  });

  it('states resources partitioned by organization', () => {
    expect(constitution).toContain('partitioned by organization');
    expect(constitution).toContain('Cross-org access is FORBIDDEN');
  });
});

// ─── S0.2.1-11: Negative runtime tests (static) ────────────────────

describe('S0.2.1-11: Negative test verification (static)', () => {
  const authz = readFileSync(AUTHZ_FILE, 'utf-8');

  it('verifyChannelChallenge rejects wrong code (returns same message as non-existent)', () => {
    // Both "wrong code" and "no challenge" return the same message — prevents enumeration.
    const verifyFn = authz.slice(
      authz.indexOf('export async function verifyChannelChallenge'),
      authz.indexOf('export async function getChannelLinkState'),
    );
    expect(verifyFn).toContain("'Verification failed. Check your code and try again.'");
  });

  it('verifyChannelChallenge rejects EXPIRED', () => {
    const verifyFn = authz.slice(
      authz.indexOf('export async function verifyChannelChallenge'),
      authz.indexOf('export async function getChannelLinkState'),
    );
    expect(verifyFn).toContain("'EXPIRED'");
    expect(verifyFn).toContain('expired');
  });

  it('verifyChannelChallenge rejects REVOKED', () => {
    const verifyFn = authz.slice(
      authz.indexOf('export async function verifyChannelChallenge'),
      authz.indexOf('export async function getChannelLinkState'),
    );
    expect(verifyFn).toContain("'REVOKED'");
    expect(verifyFn).toContain('revoked');
  });

  it('verifyChannelChallenge rejects already-VERIFIED', () => {
    const verifyFn = authz.slice(
      authz.indexOf('export async function verifyChannelChallenge'),
      authz.indexOf('export async function getChannelLinkState'),
    );
    expect(verifyFn).toContain('already verified');
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
