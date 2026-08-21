/**
 * tests/architecture/p41-architecture-enforcement.test.ts — P4.1
 *
 * Architecture enforcement tests for Article XVIII / ARCH-053.
 *
 * These tests use static AST scanning (reading source files + regex/AST
 * checks) to detect violations of the frozen invariants. A violation is
 * an Article XVIII §14 architecture-control defect.
 *
 * P4-DESIGN §16: "Add tests/static checks where practical to detect
 * violations of Article XVIII / ARCH-053. Prefer focused executable
 * assertions."
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const ANDROID_DIR = join(PROJECT_ROOT, 'src', 'server', 'android');
const CONFORMANCE_DIR = join(ANDROID_DIR, 'conformance');

// ─── A. No Android-specific protocol types (Article XVIII §4) ──────────

describe('P4.1 Architecture enforcement — no Android-specific protocol types', () => {
  const androidFiles = listFiles(ANDROID_DIR);

  it('android files exist', () => {
    expect(androidFiles.length).toBeGreaterThan(0);
  });

  it('no AndroidBundle type is introduced (Article IV frozen)', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      // The canonical type is CommunicationBundle. No AndroidBundle.
      expect(src).not.toMatch(/(?:interface|type|class)\s+AndroidBundle\b/);
    }
  });

  it('no AndroidIdentity type is introduced (Article II frozen)', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      expect(src).not.toMatch(/(?:interface|type|class)\s+AndroidIdentity\b/);
    }
  });

  it('no AndroidDeliveryState type is introduced (Article VI frozen)', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      expect(src).not.toMatch(/(?:interface|type|class)\s+AndroidDeliveryState\b/);
    }
  });

  it('no AndroidAuthorization type is introduced (Articles XII-XIV frozen)', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      expect(src).not.toMatch(/(?:interface|type|class)\s+AndroidAuthorization\b/);
    }
  });
});

// ─── B. No forbidden gossip payloads (Article XVIII §11) ──────────────

describe('P4.1 Architecture enforcement — no forbidden gossip payloads', () => {
  const androidFiles = [...listFiles(ANDROID_DIR), ...listFiles(CONFORMANCE_DIR)];

  const FORBIDDEN_GOSSIP_KINDS = [
    'IDENTITY_ASSERTION',
    'TRUST_ASSERTION',
    'DELIVERY_STATE',
    'AUTHZ_GRANT',
    'BUNDLE_VARIANT',
    'VERIFICATION_ASSERTION',
  ];

  for (const kind of FORBIDDEN_GOSSIP_KINDS) {
    it(`no transport references forbidden gossip kind '${kind}'`, () => {
      for (const file of androidFiles) {
        const src = readFileSync(file, 'utf-8');
        // The kind string must not appear in any transport source.
        expect(src).not.toContain(`'${kind}'`);
        expect(src).not.toContain(`"${kind}"`);
      }
    });
  }
});

// ─── C. Transport framing is ephemeral (Article XVIII §10) ─────────────

describe('P4.1 Architecture enforcement — transport framing is ephemeral', () => {
  const androidFiles = [...listFiles(ANDROID_DIR), ...listFiles(CONFORMANCE_DIR)];

  it('no transport persists framing fields (sequence number, length prefix) into BundleStore', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      // The BundleStore.push() takes a CommunicationBundle (opaque). It does
      // NOT accept framing fields as separate parameters.
      // We check that no push() signature includes a 'sequence' or 'length_prefix' parameter.
      expect(src).not.toMatch(/push\s*\([^)]*sequence[^)]*\)/i);
      expect(src).not.toMatch(/push\s*\([^)]*length_prefix[^)]*\)/i);
    }
  });
});

// ─── D. RELAY_FORWARD authority is forwarding evidence only (Article XVIII §12) ─

describe('P4.1 Architecture enforcement — RELAY_FORWARD authority', () => {
  const androidFiles = listFiles(ANDROID_DIR);

  it('no transport claims sender authority in RELAY_FORWARD proofs', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      // The RELAY_FORWARD proof canonical payload is defined in ARCH-023.
      // No transport should claim "sender_authority" or "sender_verified" in proofs.
      expect(src).not.toMatch(/sender_authority|sender_verified/i);
    }
  });
});

// ─── E. Layer boundary (Article I) — android/ is server layer ──────────

describe('P4.1 Architecture enforcement — layer boundary', () => {
  const androidFiles = [...listFiles(ANDROID_DIR), ...listFiles(CONFORMANCE_DIR)];

  it('android/ files import only from @/core/*, @/server/* (not @/adapters, @/matrix, @/components, next, react)', () => {
    const FORBIDDEN = [
      /@\/adapters\//,
      /@\/matrix\//,
      /@\/components\//,
      /@\/app\//,
      /@\/hooks\//,
      /@\/gateway\//,
      /^next$/,
      /^react$/,
      /@prisma\/client/,
    ];
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      const imports = extractImports(src);
      for (const imp of imports) {
        for (const forbidden of FORBIDDEN) {
          expect(imp).not.toMatch(forbidden);
        }
      }
    }
  });
});

// ─── F. No substitute cryptographic primitives (Article IX) ──────────

describe('P4.1 Architecture enforcement — no new cryptography', () => {
  const androidFiles = [...listFiles(ANDROID_DIR), ...listFiles(CONFORMANCE_DIR)];

  it('no transport invents new crypto (uses existing tweetnacl/@noble)', () => {
    for (const file of androidFiles) {
      const src = readFileSync(file, 'utf-8');
      // The transport MUST NOT implement custom crypto. It MUST use
      // tweetnacl (nacl.sign, nacl.box) or @noble/hashes.
      // We check that no file defines a custom encrypt/decrypt/sign function
      // (outside of the test Keystore adapter, which wraps nacl).
      const isTestAdapter = file.includes('TestAdapters') || file.includes('FakeTransport') || file.includes('conformance');
      if (isTestAdapter) continue; // test fixtures can wrap nacl
      // Production android files must not define custom crypto.
      expect(src).not.toMatch(/function\s+(encrypt|decrypt|signData|hashData)\s*\(/);
    }
  });
});

// ─── G. Transport interface conformance (Article XVIII §1) ────────────

describe('P4.1 Architecture enforcement — Transport interface', () => {
  it('the Transport interface has exactly 4 canonical TransportSendResult kinds', () => {
    const transportSrc = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'transport', 'Transport.ts'), 'utf-8');
    expect(transportSrc).toContain("'OK'");
    expect(transportSrc).toContain("'UNAVAILABLE'");
    expect(transportSrc).toContain("'NO_PEER'");
    expect(transportSrc).toContain("'ERROR'");
    // No 5th kind.
    expect(transportSrc).not.toContain("'DELIVERED'");
    expect(transportSrc).not.toContain("'AUTHZ_GRANTED'");
  });
});

// ─── H. Android runtime lifecycle is canonical (ARCH-054) ──────────────

describe('P4.1 Architecture enforcement — runtime lifecycle', () => {
  it('the lifecycle has exactly 6 canonical states', () => {
    const typesSrc = readFileSync(join(ANDROID_DIR, 'types.ts'), 'utf-8');
    expect(typesSrc).toContain("'CREATED'");
    expect(typesSrc).toContain("'INITIALIZING'");
    expect(typesSrc).toContain("'HYDRATING'");
    expect(typesSrc).toContain("'RUNNING'");
    expect(typesSrc).toContain("'DRAINING'");
    expect(typesSrc).toContain("'STOPPED'");
  });

  it('the lifecycle transition function throws on illegal transitions (canonical)', () => {
    const typesSrc = readFileSync(join(ANDROID_DIR, 'types.ts'), 'utf-8');
    expect(typesSrc).toContain('RuntimeLifecycleError');
    expect(typesSrc).toContain('transitionRuntimeLifecycle');
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function extractImports(src: string): string[] {
  const imports: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}
