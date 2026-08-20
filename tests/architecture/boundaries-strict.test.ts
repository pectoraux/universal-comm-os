/**
 * Strict architecture boundary tests (Architecture Constitution Article I).
 *
 * Scans source files directly for forbidden cross-layer import statements.
 * This makes CI fail when a developer accidentally adds `import ... from '@/adapters/whatsapp'`
 * inside core, or `import ... from '@/matrix/...'` inside core, etc.
 *
 * Rules (Architecture Constitution Article I):
 *   - core/* MUST NOT import from @/adapters/*
 *   - core/* MUST NOT import from @/matrix/*
 *   - core/* MUST NOT import from @/transport/loopback | lan | internet | dtn  (impl dirs)
 *   - core/* MUST NOT import from @/components/*  @/app/*  @/hooks/*
 *   - core/* MUST NOT import 'next' | 'react' | '@prisma/client'
 *   - transport/* MAY import core, MAY NOT import adapters/matrix
 *   - adapters/* MAY import core, MAY NOT import matrix/transport
 *   - matrix/* MAY import core, MAY NOT import adapters
 *   - app/components/* MUST NOT import directly from @/adapters/*
 *
 * We do this by reading files from disk with fs and asserting on text.
 * This is intentional — TS import-cycle plugins are complex and brittle; a
 * simple text scan is robust and human-readable in CI failure messages.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const SRC = join(PROJECT_ROOT, 'src');

function listFiles(dir: string, ext: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listFiles(full, ext, out);
    } else if (ext.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const SRC_EXTENSIONS = ['.ts', '.tsx'];

function readImports(filePath: string): string[] {
  const text = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];
  // Match: import ... from '...'
  const re = /from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    imports.push(m[1]);
  }
  // Also catch dynamic imports.
  const re2 = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = re2.exec(text)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

const FORBIDDEN_FROM_CORE: RegExp[] = [
  /@\/adapters\//,
  /@\/matrix\//,
  /@\/transport\/(loopback|lan|internet|dtn)/, // transport/Transport (interface) is fine
  /@\/components\//,
  /@\/app\//,
  /@\/hooks\//,
  /@\/server\//,
  /@\/gateway\//,
  /^next$/,
  /^next\/.+/,
  /^react$/,
  /^react\/.+/,
  /^react-dom$/,
  /@prisma\/client/,
  /next-auth/,
  /@tanstack\//,
  /zustand/,
  /framer-motion/,
];

function isForbiddenFromCore(imp: string): boolean {
  return FORBIDDEN_FROM_CORE.some((re) => re.test(imp));
}

const FORBIDDEN_FROM_TRANSPORT_IMPL: RegExp[] = [
  /@\/adapters\//,
  /@\/matrix\//,
  /@\/components\//,
  /@\/app\//,
  /@\/hooks\//,
  /next$/,
  /react$/,
];

function isForbiddenFromTransportImpl(imp: string): boolean {
  return FORBIDDEN_FROM_TRANSPORT_IMPL.some((re) => re.test(imp));
}

const FORBIDDEN_FROM_ADAPTERS: RegExp[] = [
  /@\/matrix\//,
  /@\/transport\/(loopback|lan|internet|dtn)/,
  /@\/components\//,
  /@\/app\//,
  /@\/hooks\//,
  /next$/,
  /react$/,
];

function isForbiddenFromAdapters(imp: string): boolean {
  return FORBIDDEN_FROM_ADAPTERS.some((re) => re.test(imp));
}

// P6: gateway/* may import core/* + adapters/* (Architecture Constitution
// Article I.4). It MUST NOT import matrix/*, transport impl, UI, or framework.
const FORBIDDEN_FROM_GATEWAY: RegExp[] = [
  /@\/matrix\//,
  /@\/transport\/(loopback|lan|internet|dtn)/,
  /@\/components\//,
  /@\/app\//,
  /@\/hooks\//,
  /next$/,
  /react$/,
];

function isForbiddenFromGateway(imp: string): boolean {
  return FORBIDDEN_FROM_GATEWAY.some((re) => re.test(imp));
}

describe('Architecture (strict): forbidden imports', () => {
  const coreFiles = listFiles(join(SRC, 'core'), SRC_EXTENSIONS);

  it('core/ contains TypeScript files', () => {
    expect(coreFiles.length).toBeGreaterThan(0);
  });

  it('core/ has no forbidden imports', () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      for (const imp of readImports(file)) {
        if (isForbiddenFromCore(imp)) {
          violations.push(`${relative(PROJECT_ROOT, file)}: ${imp}`);
        }
      }
    }
    if (violations.length > 0) {
      // Helpful failure message.
      throw new Error(
        `Forbidden imports in src/core/*:\n${violations.map((v) => '  - ' + v).join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('transport/impl has no forbidden imports', () => {
    const transportImplDirs = ['loopback', 'lan', 'internet', 'dtn'];
    const violations: string[] = [];
    for (const dir of transportImplDirs) {
      const files = listFiles(join(SRC, 'transport', dir), SRC_EXTENSIONS);
      for (const file of files) {
        for (const imp of readImports(file)) {
          if (isForbiddenFromTransportImpl(imp)) {
            violations.push(`${relative(PROJECT_ROOT, file)}: ${imp}`);
          }
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Forbidden imports in src/transport/{loopback,lan,internet,dtn}/*:\n${violations
          .map((v) => '  - ' + v)
          .join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('adapters/ has no forbidden imports', () => {
    const adapterFiles = listFiles(join(SRC, 'adapters'), SRC_EXTENSIONS);
    const violations: string[] = [];
    for (const file of adapterFiles) {
      for (const imp of readImports(file)) {
        if (isForbiddenFromAdapters(imp)) {
          violations.push(`${relative(PROJECT_ROOT, file)}: ${imp}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Forbidden imports in src/adapters/*:\n${violations.map((v) => '  - ' + v).join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('gateway/ has no forbidden imports (P6)', () => {
    const gatewayFiles = listFiles(join(SRC, 'gateway'), SRC_EXTENSIONS);
    const violations: string[] = [];
    for (const file of gatewayFiles) {
      for (const imp of readImports(file)) {
        if (isForbiddenFromGateway(imp)) {
          violations.push(`${relative(PROJECT_ROOT, file)}: ${imp}`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Forbidden imports in src/gateway/*:\n${violations.map((v) => '  - ' + v).join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it('app/ and components/ do not directly invoke channel adapters', () => {
    // The UI is a consumer of the Communication OS API (Article I.6).
    // UI MUST NOT directly import from @/adapters/* (it would couple the UI to a channel).
    const uiFiles = [
      ...listFiles(join(SRC, 'app'), SRC_EXTENSIONS),
      ...listFiles(join(SRC, 'components'), SRC_EXTENSIONS),
    ];
    const violations: string[] = [];
    for (const file of uiFiles) {
      for (const imp of readImports(file)) {
        if (/@\/adapters\//.test(imp)) {
          violations.push(`${relative(PROJECT_ROOT, file)}: ${imp}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('Architecture (strict): no fake implementations in core', () => {
  // Forbidden tokens in core/* (Article X).
  // AUDIT-FIX: added 'synthesize', 'simulate', 'approximate', 'best-effort guess'
  // to catch dishonest implementations.
  const FORBIDDEN_TOKENS = ['TODO', 'FIXME', 'placeholder', 'fake success', 'hardcoded route', 'synthesize', 'simulate', 'approximate', 'best-effort guess'];

  it('core/ has no TODO / stub / placeholder / fake', () => {
    const files = listFiles(join(SRC, 'core'), SRC_EXTENSIONS);
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const tok of FORBIDDEN_TOKENS) {
        if (text.toLowerCase().includes(tok.toLowerCase())) {
          violations.push(`${relative(PROJECT_ROOT, file)}: contains "${tok}"`);
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        `Article X violation — no fake implementations:\n${violations.map((v) => '  - ' + v).join('\n')}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
