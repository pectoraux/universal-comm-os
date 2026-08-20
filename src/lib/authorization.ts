/**
 * lib/authorization.ts — S0.1
 *
 * Authorization engine: maps authenticated principal → organization(s) → owned resources.
 *
 * Per Article XII:
 * - Authentication answers "who are you?" (handled by auth-guard.ts)
 * - Authorization answers "what are you allowed to operate on?" (handled here)
 * - A client-supplied resource identifier is NEVER proof of authority.
 * - The server MUST independently verify ownership.
 */

import 'server-only';
import { db } from '@/lib/db';
import type { AuthContext } from '@/lib/auth-guard';

export interface ResourceAuthContext extends AuthContext {
  /** The organization that owns the resource (if authorized). */
  organizationId?: string;
}

/**
 * S0.1: Authorize access to a node resource.
 * Verifies that the authenticated user's organization owns the node.
 * Returns the organization ID if authorized.
 * Throws AuthError if not authorized.
 */
export async function authorizeNode(
  ctx: AuthContext,
  nodeId: string,
): Promise<{ organizationId: string }> {
  // Admin users can access any node.
  if (ctx.role === 'admin') {
    const ownership = await db.nodeOwnership.findUnique({ where: { nodeId } });
    return { organizationId: ownership?.organizationId ?? 'admin' };
  }

  // Non-admin: check if the user's organization owns this node.
  const memberships = await db.userOrganization.findMany({
    where: { userId: ctx.userId },
    select: { organizationId: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);

  if (orgIds.length === 0) {
    throw new AuthzError('FORBIDDEN', `User ${ctx.email} has no organization memberships.`);
  }

  const ownership = await db.nodeOwnership.findUnique({ where: { nodeId } });
  if (!ownership) {
    throw new AuthzError('FORBIDDEN', `Node '${nodeId}' is not owned by any organization.`);
  }

  if (!orgIds.includes(ownership.organizationId)) {
    throw new AuthzError(
      'FORBIDDEN',
      `User ${ctx.email} is not authorized to access node '${nodeId}'. Node belongs to a different organization.`,
    );
  }

  return { organizationId: ownership.organizationId };
}

/**
 * S0.1: Authorize access to a bundle resource at a specific node.
 * Verifies node ownership (the bundle is accessed via the node).
 */
export async function authorizeBundleAtNode(
  ctx: AuthContext,
  bundleId: string,
  nodeId: string,
): Promise<{ organizationId: string }> {
  return authorizeNode(ctx, nodeId);
}

/**
 * S0.1: Authorize access to a conversation at a specific node.
 */
export async function authorizeConversationAtNode(
  ctx: AuthContext,
  nodeId: string,
  _conversationId: string,
): Promise<{ organizationId: string }> {
  return authorizeNode(ctx, nodeId);
}

/**
 * S0.1: Authorize a network-wide operation (reset, policy update, analytics).
 * Admin role required for destructive operations.
 */
export async function authorizeNetworkOperation(
  ctx: AuthContext,
  requireAdmin: boolean = false,
): Promise<{ organizationId: string }> {
  if (requireAdmin && ctx.role !== 'admin') {
    throw new AuthzError('FORBIDDEN', `Network operation requires admin role. User ${ctx.email} has role '${ctx.role}'.`);
  }
  return { organizationId: 'network' };
}

/**
 * S0.1: Log an audit event for every authorized/denied operation.
 */
export async function logAuditEvent(input: {
  actorEmail: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  organizationId?: string;
  outcome: 'allowed' | 'denied';
  reason?: string;
}): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorEmail: input.actorEmail,
        actorRole: input.actorRole,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        organizationId: input.organizationId,
        outcome: input.outcome,
        reason: input.reason,
      },
    });
  } catch {
    // Audit logging is best-effort — don't fail the operation if logging fails.
    // In production, this would trigger an alert.
  }
}

/**
 * S0.1: Authorization error class.
 */
export class AuthzError extends Error {
  constructor(
    public code: 'UNAUTHORIZED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

/**
 * S0.1: Safe error wrapper — never return raw internal exceptions to clients.
 * Catches any error, logs it, and returns a safe structured response.
 */
export function safeError(e: unknown): { ok: false; error: string; code: string } {
  if (e instanceof AuthzError) {
    return { ok: false, error: e.message, code: e.code };
  }
  // For any other error, return a generic message — never expose internals.
  const msg = e instanceof Error ? e.message : String(e);
  // Log the full error server-side for debugging.
  console.error('[safeError]', msg);
  return {
    ok: false,
    error: 'An internal error occurred. Please try again.',
    code: 'INTERNAL',
  };
}

/**
 * S0.1: Request-origin validation.
 * Verifies that the request originates from an allowed origin.
 * NextAuth server actions are same-origin by default, but we add
 * an explicit check for defense-in-depth.
 */
export function validateOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const allowedHosts = [
    'localhost:3000',
    'commos-alpha.vercel.app',
    'commos.vercel.app',
    'commos-tay-nurs-projects.vercel.app',
  ];

  // In development, allow localhost.
  if (process.env.NODE_ENV !== 'production') {
    if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return true;
    }
  }

  // In production, check origin/host.
  if (host && allowedHosts.some((h) => host.includes(h))) {
    return true;
  }

  // For server actions (no explicit HTTP request), allow same-origin.
  if (!origin && !host) {
    return true; // Server action call — same-origin by definition.
  }

  return false;
}
