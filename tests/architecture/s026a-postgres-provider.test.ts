/**
 * S0.2.6-A — Prisma schema provider architecture test.
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
 * This test enforces the frozen invariant. A failure means someone
 * changed the Prisma schema provider to SQLite (or another non-PostgreSQL
 * database) — which is an architecture-control defect.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const PRISMA_SCHEMA = join(PROJECT_ROOT, 'prisma', 'schema.prisma');

describe('S0.2.6-A: Prisma schema provider MUST be postgresql', () => {
  const schema = readFileSync(PRISMA_SCHEMA, 'utf-8');

  it('the datasource provider is postgresql', () => {
    // Extract the datasource block.
    const dsMatch = schema.match(/datasource\s+\w+\s*\{[^}]*\}/s);
    expect(dsMatch).toBeTruthy();
    const dsBlock = dsMatch![0];

    // The provider MUST be "postgresql".
    expect(dsBlock).toContain('provider = "postgresql"');

    // The provider MUST NOT be "sqlite".
    expect(dsBlock).not.toContain('provider = "sqlite"');
  });

  it('the schema does not mention SQLite as the database', () => {
    // The comment should not say "SQLite for local dev" — that's the
    // regression we're preventing.
    expect(schema).not.toMatch(/SQLite\s+for\s+local\s+dev/i);
  });

  it('the schema comment references PostgreSQL', () => {
    // The canonical comment references PostgreSQL/Neon.
    expect(schema).toMatch(/PostgreSQL/i);
  });

  it('the DATABASE_URL env var format is postgresql://', () => {
    // Verify the .env file uses a PostgreSQL connection string (not file:).
    const env = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8');
    expect(env).toMatch(/DATABASE_URL=postgresql:\/\//);
    expect(env).not.toMatch(/DATABASE_URL=file:/);
  });
});
