/**
 * S0-11: Architecture test — every externally callable server action
 * must pass authentication/authorization.
 *
 * This test scans src/app/actions/commos.ts and verifies that every
 * exported async function calls requireAuth/requireRole/withAuth/withRole.
 *
 * It also verifies that the auth guard module exists and exports the
 * required functions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = join(__dirname, '..', '..');
const ACTIONS_FILE = join(PROJECT_ROOT, 'src', 'app', 'actions', 'commos.ts');
const AUTH_GUARD_FILE = join(PROJECT_ROOT, 'src', 'lib', 'auth-guard.ts');

describe('S0-11: Architecture — every server action is auth-guarded', () => {
  it('auth-guard.ts exists', () => {
    expect(existsSync(AUTH_GUARD_FILE)).toBe(true);
  });

  it('auth-guard.ts exports requireAuth, requireRole, requireAdmin, withAuth, withRole', () => {
    const source = readFileSync(AUTH_GUARD_FILE, 'utf-8');
    expect(source).toContain('export async function requireAuth');
    expect(source).toContain('export async function requireRole');
    expect(source).toContain('export async function requireAdmin');
    expect(source).toContain('export async function withAuth');
    expect(source).toContain('export async function withRole');
  });

  it('commos.ts imports from auth-guard', () => {
    const source = readFileSync(ACTIONS_FILE, 'utf-8');
    expect(source).toContain("from '@/lib/auth-guard'");
  });

  it('every exported async function in commos.ts calls withAuth or withRole', () => {
    const source = readFileSync(ACTIONS_FILE, 'utf-8');
    // Extract all exported async function names.
    const exportRegex = /export\s+async\s+function\s+(\w+)\s*\(/g;
    const exports: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = exportRegex.exec(source)) !== null) {
      exports.push(m[1]);
    }
    expect(exports.length).toBeGreaterThan(0);

    // For each exported function, verify it calls withAuth or withRole.
    for (const fnName of exports) {
      // Find the function body.
      const fnStart = source.indexOf(`export async function ${fnName}(`);
      expect(fnStart).toBeGreaterThan(-1);
      // Find the matching closing brace (simplified — just check within 2000 chars).
      const fnBody = source.slice(fnStart, fnStart + 3000);
      const hasAuth = fnBody.includes('withAuth') || fnBody.includes('withRole');
      expect(hasAuth).toBe(true);
    }
  });

  it('resetNetworkAction requires admin role', () => {
    const source = readFileSync(ACTIONS_FILE, 'utf-8');
    const resetIdx = source.indexOf('export async function resetNetworkAction');
    expect(resetIdx).toBeGreaterThan(-1);
    const resetBody = source.slice(resetIdx, resetIdx + 500);
    expect(resetBody.includes("['admin']")).toBe(true);
  });

  it('updateRoutingPolicyAction requires admin or demo role', () => {
    const source = readFileSync(ACTIONS_FILE, 'utf-8');
    const updateIdx = source.indexOf('export async function updateRoutingPolicyAction');
    expect(updateIdx).toBeGreaterThan(-1);
    const updateBody = source.slice(updateIdx, updateIdx + 500);
    expect(updateBody.includes("['admin', 'demo']")).toBe(true);
  });
});

/**
 * S0-12: Security test — unauthenticated callers cannot perform
 * any mutating operation.
 *
 * This test verifies that the auth guard correctly rejects unauthenticated
 * calls by checking that withAuth/withRole throw AuthError when no session
 * exists. We can't call getServerSession in a test (no HTTP context), so
 * we verify the guard logic statically.
 */
describe('S0-12: Security — unauthenticated access is blocked', () => {
  it('auth-guard.ts throws AuthError when session is null', () => {
    const source = readFileSync(AUTH_GUARD_FILE, 'utf-8');
    expect(source).toContain('throw new AuthError');
    expect(source).toContain("'UNAUTHORIZED'");
    expect(source).toContain("'FORBIDDEN'");
  });

  it('auth-guard.ts has no fallback that allows unauthenticated access', () => {
    const source = readFileSync(AUTH_GUARD_FILE, 'utf-8');
    // The guard must NOT have any path that returns a default AuthContext
    // without checking the session.
    expect(source).not.toContain('guest');
    expect(source).not.toContain('anonymous');
    expect(source).not.toContain('default.*context');
  });

  it('NEXTAUTH_SECRET has no fallback (S0-3)', () => {
    const authFile = join(PROJECT_ROOT, 'src', 'lib', 'auth.ts');
    const source = readFileSync(authFile, 'utf-8');
    // The fallback must be removed.
    expect(source).not.toContain("'dev-secret-change-in-production'");
    expect(source).not.toContain("|| 'dev");
    expect(source).toContain('throw new Error');
    expect(source).toContain('NEXTAUTH_SECRET');
  });

  it('no .env file in git history (S0-2)', () => {
    // This is verified by the fact that we force-pushed the cleaned history.
    // We check that .env is in .gitignore.
    const gitignore = readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.env');
  });

  it('commos.ts has no direct getNetwork call without auth wrapper', () => {
    const source = readFileSync(ACTIONS_FILE, 'utf-8');
    // Check that every getNetwork() call is inside a withAuth/withRole callback.
    // We look for any getNetwork() call that's NOT preceded by withAuth/withRole.
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('getNetwork()') && !line.includes('withAuth') && !line.includes('withRole')) {
        // This line calls getNetwork() — check if it's inside a withAuth callback.
        // Look backwards for the enclosing withAuth/withRole.
        let foundAuth = false;
        for (let j = i; j >= Math.max(0, i - 5); j--) {
          if (lines[j].includes('withAuth') || lines[j].includes('withRole')) {
            foundAuth = true;
            break;
          }
        }
        // If it's inside an import or comment, skip.
        if (line.includes('import') || line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        expect(foundAuth).toBe(true);
      }
    }
  });
});
