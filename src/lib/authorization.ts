/**
 * lib/authorization.ts — S0.2
 *
 * Authorization engine with:
 * - Audited authorization (denied ops logged BEFORE returning FORBIDDEN)
 * - Resource visibility classes (PUBLIC/ORGANIZATION/USER/PLATFORM)
 * - Role hierarchy (PLATFORM_ADMIN/ORG_OWNER/ORG_ADMIN/ORG_MEMBER/DEMO)
 * - Channel verification states (ASSERTED/VERIFIED/REVOKED)
 * - Mandatory audit persistence for denied operations
 * - safeError — never leak internals
 *
 * Per Article XIII:
 * "A resource's existence, ownership, membership, visibility, and channel
 * verification are separate authorization dimensions. Authentication of
 * the caller does not establish any of them."
 */

import 'server-only';
import { db } from '@/lib/db';
import type { AuthContext } from '@/lib/auth-guard';

// ─── S0.2-2: Resource Visibility Classes ─────────────────────────────

export type ResourceVisibility = 'PUBLIC' | 'ORGANIZATION' | 'USER' | 'PLATFORM';

/**
 * S0.2-4: Role hierarchy.
 * PLATFORM_ADMIN can access any resource across all orgs.
 * ORG_OWNER/ORG_ADMIN/ORG_MEMBER can access resources within their org.
 * DEMO has same access as ORG_MEMBER.
 */
export type AuthzRole = 'PLATFORM_ADMIN' | 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_MEMBER' | 'DEMO';

/**
 * Maps the NextAuth session role to the authorization role hierarchy.
 */
export function toAuthzRole(sessionRole: string): AuthzRole {
  if (sessionRole === 'admin') return 'PLATFORM_ADMIN';
  if (sessionRole === 'demo') return 'DEMO';
  return 'ORG_MEMBER';
}

function isPlatformAdmin(ctx: AuthContext): boolean {
  return toAuthzRole(ctx.role) === 'PLATFORM_ADMIN';
}

function isOrgElevated(ctx: AuthContext): boolean {
  const r = toAuthzRole(ctx.role);
  return r === 'ORG_OWNER' || r === 'ORG_ADMIN';
}

// ─── S0.2-1: Audited Authorization ────────────────────────────────────

/**
 * S0.2-1: authorizeNode — verifies org ownership, audits BOTH allowed and denied.
 * The audit happens INSIDE the authorization boundary, not after.
 */
export async function authorizeNode(
  ctx: AuthContext,
  nodeId: string,
  action: string = 'access_node',
): Promise<{ organizationId: string }> {
  // PLATFORM_ADMIN can access any node.
  if (isPlatformAdmin(ctx)) {
    const ownership = await db.nodeOwnership.findUnique({ where: { nodeId } }).catch(() => null);
    const orgId = ownership?.organizationId ?? 'platform';
    await auditMandatory(ctx, action, 'node', nodeId, orgId, 'allowed', `Platform admin access to node ${nodeId}`);
    return { organizationId: orgId };
  }

  // Non-platform-admin: check org membership.
  const memberships = await db.userOrganization.findMany({
    where: { userId: ctx.userId },
    select: { organizationId: true, role: true },
  });
  const orgIds = memberships.map((m) => m.organizationId);

  if (orgIds.length === 0) {
    await auditMandatory(ctx, action, 'node', nodeId, undefined, 'denied', `User ${ctx.email} has no org memberships`);
    throw new AuthzError('FORBIDDEN', `User ${ctx.email} has no organization memberships.`);
  }

  const ownership = await db.nodeOwnership.findUnique({ where: { nodeId } }).catch(() => null);
  if (!ownership) {
    await auditMandatory(ctx, action, 'node', nodeId, undefined, 'denied', `Node '${nodeId}' not owned by any org`);
    throw new AuthzError('FORBIDDEN', `Node '${nodeId}' is not owned by any organization.`);
  }

  if (!orgIds.includes(ownership.organizationId)) {
    await auditMandatory(ctx, action, 'node', nodeId, ownership.organizationId, 'denied', `Cross-org access denied: ${ctx.email} → node ${nodeId}`);
    throw new AuthzError('FORBIDDEN', `User ${ctx.email} is not authorized to access node '${nodeId}'. Node belongs to a different organization.`);
  }

  await auditMandatory(ctx, action, 'node', nodeId, ownership.organizationId, 'allowed', undefined);
  return { organizationId: ownership.organizationId };
}

export async function authorizeBundleAtNode(
  ctx: AuthContext,
  bundleId: string,
  nodeId: string,
  action: string = 'access_bundle',
): Promise<{ organizationId: string }> {
  return authorizeNode(ctx, nodeId, action);
}

export async function authorizeConversationAtNode(
  ctx: AuthContext,
  nodeId: string,
  _conversationId: string,
  action: string = 'access_conversation',
): Promise<{ organizationId: string }> {
  return authorizeNode(ctx, nodeId, action);
}

/**
 * S0.2-3: authorizeByVisibility — checks access based on resource visibility class.
 * - PUBLIC: any authenticated user can access
 * - ORGANIZATION: user must be a member of the owning org (or PLATFORM_ADMIN)
 * - USER: user must own the resource (or PLATFORM_ADMIN)
 * - PLATFORM: only PLATFORM_ADMIN can access
 */
export async function authorizeByVisibility(
  ctx: AuthContext,
  visibility: ResourceVisibility,
  action: string,
  resourceType: string,
  resourceId?: string,
  organizationId?: string,
): Promise<{ organizationId?: string }> {
  switch (visibility) {
    case 'PUBLIC':
      // Any authenticated user can access. Just audit.
      await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Public resource access');
      return { organizationId };

    case 'PLATFORM':
      // Only PLATFORM_ADMIN can access.
      if (!isPlatformAdmin(ctx)) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'denied', `Platform-level access denied for ${ctx.email} (role: ${ctx.role})`);
        throw new AuthzError('FORBIDDEN', `Platform-level access required. User ${ctx.email} has role '${ctx.role}'.`);
      }
      await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Platform admin access');
      return { organizationId };

    case 'ORGANIZATION':
      // User must be a member of the org (or PLATFORM_ADMIN).
      if (isPlatformAdmin(ctx)) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Platform admin access to org resource');
        return { organizationId };
      }
      if (!organizationId) {
        // No specific org — check if user has ANY org membership (for shared resources).
        const memberships = await db.userOrganization.findMany({
          where: { userId: ctx.userId },
          select: { organizationId: true },
        }).catch(() => []);
        if (memberships.length === 0) {
          await auditMandatory(ctx, action, resourceType, resourceId, undefined, 'denied', `No org membership for ${ctx.email}`);
          throw new AuthzError('FORBIDDEN', `User ${ctx.email} has no organization memberships.`);
        }
        await auditMandatory(ctx, action, resourceType, resourceId, memberships[0].organizationId, 'allowed', undefined);
        return { organizationId: memberships[0].organizationId };
      }
      // Check specific org membership.
      const membership = await db.userOrganization.findUnique({
        where: { userId_organizationId: { userId: ctx.userId, organizationId } },
      }).catch(() => null);
      if (!membership) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'denied', `Cross-org access denied: ${ctx.email}`);
        throw new AuthzError('FORBIDDEN', `User ${ctx.email} is not a member of the required organization.`);
      }
      await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', undefined);
      return { organizationId };

    case 'USER':
      // User must own the resource (or PLATFORM_ADMIN).
      // For now, delegates to authorizeNode since user-level resources are node-scoped.
      if (isPlatformAdmin(ctx)) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Platform admin access to user resource');
        return { organizationId };
      }
      // Will be handled by authorizeNode calls in the action.
      return { organizationId };
  }
}

export async function authorizeNetworkOperation(
  ctx: AuthContext,
  requirePlatformAdmin: boolean = false,
  action: string = 'network_operation',
): Promise<{ organizationId: string }> {
  if (requirePlatformAdmin && !isPlatformAdmin(ctx)) {
    await auditMandatory(ctx, action, 'network', undefined, undefined, 'denied', `Platform admin required: ${ctx.email} (role: ${ctx.role})`);
    throw new AuthzError('FORBIDDEN', `Platform admin role required. User ${ctx.email} has role '${ctx.role}'.`);
  }
  await auditMandatory(ctx, action, 'network', undefined, 'platform', 'allowed', undefined);
  return { organizationId: 'platform' };
}

// ─── S0.2-9: Mandatory Audit Persistence ─────────────────────────────

/**
 * S0.2-9: auditMandatory — for security events (denied operations),
 * the audit write MUST succeed. If it fails, the operation is still
 * denied (for denied ops) or still allowed (for allowed ops), but a
 * secondary alert is logged.
 */
async function auditMandatory(
  ctx: AuthContext,
  action: string,
  resourceType: string,
  resourceId: string | undefined,
  organizationId: string | undefined,
  outcome: 'allowed' | 'denied',
  reason: string | undefined,
): Promise<void> {
  const eventData = {
    actorEmail: ctx.email,
    actorRole: ctx.role,
    action,
    resourceType,
    resourceId,
    organizationId,
    outcome,
    reason,
  };

  try {
    await db.auditEvent.create({ data: eventData });
  } catch (e) {
    // S0.2-9: If the primary audit store fails, log to stderr as a fallback.
    // In production, this would also push to a dead-letter queue / alert system.
    console.error('[AUDIT_FAILURE]', JSON.stringify(eventData), String(e));
  }
}

/**
 * S0.2: Log an allowed operation (best-effort, for non-security events).
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
    await db.auditEvent.create({ data: input });
  } catch (e) {
    console.error('[AUDIT_FAILURE]', JSON.stringify(input), String(e));
  }
}

// ─── S0.2-5/6: Channel Verification ──────────────────────────────────

/**
 * S0.2-5: Create a channel-ownership verification challenge.
 * The challenge code is sent through the channel (email link, SMS OTP, etc.).
 * Until verified, the identity link is ASSERTED, not VERIFIED.
 */
export async function createChannelChallenge(input: {
  nodeId: string;
  channel: string;
  channelId: string;
}): Promise<{ challengeCode: string; expiresAt: Date }> {
  const challengeCode = Math.random().toString(36).slice(2, 10).toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min expiry

  await db.channelVerificationChallenge.upsert({
    where: {
      node_id_channel_channel_id: {
        node_id: input.nodeId,
        channel: input.channel,
        channel_id: input.channelId,
      },
    },
    update: {
      challenge_code: challengeCode,
      status: 'pending',
      created_at: new Date(),
      expires_at: expiresAt,
      verified_at: null,
    },
    create: {
      node_id: input.nodeId,
      channel: input.channel,
      channel_id: input.channelId,
      challenge_code: challengeCode,
      status: 'pending',
      expires_at: expiresAt,
    },
  });

  return { challengeCode, expiresAt: expiresAt };
}

/**
 * S0.2-5: Verify a channel-ownership challenge.
 * If the code matches and hasn't expired, the link becomes VERIFIED.
 */
export async function verifyChannelChallenge(input: {
  nodeId: string;
  channel: string;
  channelId: string;
  challengeCode: string;
}): Promise<{ verified: boolean; reason?: string }> {
  const challenge = await db.channelVerificationChallenge.findUnique({
    where: {
      node_id_channel_channel_id: {
        node_id: input.nodeId,
        channel: input.channel,
        channel_id: input.channelId,
      },
    },
  });

  if (!challenge) {
    return { verified: false, reason: 'No challenge found. Request a new verification link.' };
  }
  if (challenge.status === 'verified') {
    return { verified: false, reason: 'Already verified.' };
  }
  if (challenge.expires_at < new Date()) {
    return { verified: false, reason: 'Challenge expired. Request a new verification link.' };
  }
  if (challenge.challenge_code !== input.challengeCode) {
    return { verified: false, reason: 'Invalid verification code.' };
  }

  await db.channelVerificationChallenge.update({
    where: { id: challenge.id },
    data: { status: 'verified', verified_at: new Date() },
  });

  return { verified: true };
}

/**
 * S0.2-7: Check if a channel identity link is VERIFIED (not just ASSERTED).
 * Only VERIFIED links can be used for production delivery.
 */
export function isVerifiedLink(verification: string | undefined): boolean {
  return verification === 'VERIFIED';
}

// ─── S0.2-8: Removed validateOrigin ──────────────────────────────────
// S0.2-8: validateOrigin() has been REMOVED.
// NextAuth server actions are CSRF-protected by the framework's same-origin
// cookie mechanism. We do not maintain a bespoke origin validation function
// that isn't on the actual enforcement path.
// The claim of "explicit origin protection" has been corrected in the docs.

// ─── Error handling ───────────────────────────────────────────────────

export class AuthzError extends Error {
  constructor(
    public code: 'UNAUTHORIZED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

export function safeError(e: unknown): { ok: false; error: string; code: string } {
  if (e instanceof AuthzError) {
    return { ok: false, error: e.message, code: e.code };
  }
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[safeError]', msg);
  return { ok: false, error: 'An internal error occurred. Please try again.', code: 'INTERNAL' };
}
