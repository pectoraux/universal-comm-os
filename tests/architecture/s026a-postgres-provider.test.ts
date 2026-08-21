/**
 * S0.2.6-A/B — Prisma schema provider architecture test.
 *
 * The canonical Prisma schema MUST use PostgreSQL. SQLite is forbidden
 * as the datasource provider because:
 *   1. The project architecture established PostgreSQL/Neon as the
 *      database platform (frozen decision).
 *   2. Local dev must exercise the SAME database implementation as
 *      production — no drift between local tests and production behavior.
 *   3. SQLite and PostgreSQL have different SQL dialects, different
 *      transaction semantics, different WAL behavior, different JSON
 *      handling, different array handling, different index behavior.
 *      Changing the provider to SQLite makes local tests pass while
 *      hiding PostgreSQL-specific bugs.
 *
 * S0.2.6-B FIX: Removed the .env dependency. The previous version of
 * this test read `.env` (which is gitignored) — that broke on a fresh
 * clone or CI run. This version tests ONLY tracked files:
 *   - prisma/schema.prisma (the canonical schema)
 *   - .env.example (the tracked example, no secrets)
 *
 * All tests MUST pass from a fresh GitHub checkout WITHOUT any local .env.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const PRISMA_SCHEMA = join(PROJECT_ROOT, 'prisma', 'schema.prisma');
const ENV_EXAMPLE = join(PROJECT_ROOT, '.env.example');

describe('S0.2.6-B: Prisma schema provider MUST be postgresql (no .env dependency)', () => {
  const schema = readFileSync(PRISMA_SCHEMA, 'utf-8');

  it('the datasource provider is postgresql', () => {
    const dsMatch = schema.match(/datasource\s+\w+\s*\{[^}]*\}/s);
    expect(dsMatch).toBeTruthy();
    const dsBlock = dsMatch![0];

    expect(dsBlock).toContain('provider = "postgresql"');
    expect(dsBlock).not.toContain('provider = "sqlite"');
  });

  it('the schema does not mention SQLite as the database', () => {
    expect(schema).not.toMatch(/SQLite\s+for\s+local\s+dev/i);
  });

  it('the schema comment references PostgreSQL', () => {
    expect(schema).toMatch(/PostgreSQL/i);
  });

  it('the canonical schema does not use file: datasource', () => {
    const dsMatch = schema.match(/datasource\s+\w+\s*\{[^}]*\}/s);
    const dsBlock = dsMatch![0];
    expect(dsBlock).not.toMatch(/file:/i);
  });
});

describe('S0.2.6-B: .env.example is tracked and contains no secrets', () => {
  it('.env.example exists as a tracked file', () => {
    expect(existsSync(ENV_EXAMPLE)).toBe(true);
  });

  it('.env.example uses postgresql:// for DATABASE_URL', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf-8');
    expect(envExample).toMatch(/DATABASE_URL=postgresql:\/\//);
    expect(envExample).not.toMatch(/DATABASE_URL=file:/);
    expect(envExample).not.toMatch(/DATABASE_URL=sqlite:/);
  });

  it('.env.example does not contain real secrets', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf-8');
    // NEXTAUTH_SECRET must be empty (placeholder, not a real secret).
    expect(envExample).toMatch(/NEXTAUTH_SECRET=\s*$/m);
    // No base64 strings that could be real secrets.
    expect(envExample).not.toMatch(/[A-Za-z0-9+/]{32,}={0,2}/);
  });

  it('.env.example references localhost or placeholder for dev', () => {
    const envExample = readFileSync(ENV_EXAMPLE, 'utf-8');
    // The DATABASE_URL should use placeholder credentials.
    expect(envExample).toMatch(/DATABASE_URL=postgresql:\/\/\w+:\w+@\w+/);
  });
});

describe('S0.2.6-B: .env is NOT tracked (secret safety)', () => {
  it('.env is not a tracked file', () => {
    // We check git ls-files — .env should not appear.
    const tracked = execSync('git ls-files .env', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
    expect(tracked).toBe('');
  });
});
