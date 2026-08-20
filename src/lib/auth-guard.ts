'use server';

/**
 * lib/auth-guard.ts — S0-4/S0-5/S0-7
 *
 * Central authentication + authorization guard for every server action.
 * Every externally callable server action MUST call one of these guards
 * before doing any work.
 *
 * S0-4: Authenticate — verify the caller has a valid session.
 * S0-5: Authorize — verify the caller's role permits the operation.
 * S0-7: CSRF/origin — NextAuth server actions are already CSRF-protected
 *   by the session cookie (same-origin). We additionally check the
 *   session's existence to prevent unauthenticated API calls.
 * S0-6: Tenant boundaries — the user's email is attached to the operation
 *   as `actor_email` for audit trail.
 */

import 'server-only';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import type { Session } from 'next-auth';

// S0.1: Re-export authorization utilities.
export { AuthzError, safeError, logAuditEvent, authorizeNode, authorizeBundleAtNode, authorizeConversationAtNode, authorizeNetworkOperation } from '@/lib/authorization';
export type { ResourceAuthContext } from '@/lib/authorization';

export interface AuthContext {
  session: Session;
  userId: string;
  email: string;
  role: string;
  /** S0-6: actor identity for audit trail. */
  actor_email: string;
}

/**
 * S0-4: Require an authenticated session. Throws if unauthenticated.
 */
export async function requireAuth(): Promise<AuthContext> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    throw new AuthError('UNAUTHORIZED', 'Authentication required. Sign in to continue.');
  }
  const email = session.user.email ?? '';
  const role = (session.user as any).role ?? 'user';
  return {
    session,
    userId: (session.user as any).id ?? email,
    email,
    role,
    actor_email: email,
  };
}

/**
 * S0-5: Require a specific role. Throws if the caller's role doesn't match.
 */
export async function requireRole(allowedRoles: string[]): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!allowedRoles.includes(ctx.role)) {
    throw new AuthError(
      'FORBIDDEN',
      `Role '${ctx.role}' is not permitted to perform this operation. Required: ${allowedRoles.join(' or ')}.`,
    );
  }
  return ctx;
}

/**
 * S0-5: Require admin role specifically.
 */
export async function requireAdmin(): Promise<AuthContext> {
  return requireRole(['admin']);
}

/**
 * S0-5: Require any authenticated user (user, demo, or admin).
 * Use for read-only operations that any authenticated user can perform.
 */
export async function requireUser(): Promise<AuthContext> {
  return requireRole(['user', 'demo', 'admin']);
}

/**
 * Error class for auth failures. Server actions should catch this and
 * return a structured error response.
 */
export class AuthError extends Error {
  constructor(
    public code: 'UNAUTHORIZED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Helper: safely execute a server action with auth guard.
 * Returns the result or a structured error.
 */
export async function withAuth<T>(
  fn: (ctx: AuthContext) => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; code: string }> {
  try {
    const ctx = await requireAuth();
    const data = await fn(ctx);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: String(e), code: 'INTERNAL' };
  }
}

/**
 * Helper: safely execute a server action with role guard.
 */
export async function withRole<T>(
  roles: string[],
  fn: (ctx: AuthContext) => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; code: string }> {
  try {
    const ctx = await requireRole(roles);
    const data = await fn(ctx);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: String(e), code: 'INTERNAL' };
  }
}
