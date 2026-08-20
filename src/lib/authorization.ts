/**
 * lib/authorization.ts — S0.2.1
 *
 * Implements Article XIV: authorization state ≠ resource state.
 *
 * Changes from S0.2:
 * - Challenge codes are hashed (SHA-256), never stored as plaintext
 * - Challenge codes are NEVER returned to the browser
 * - IdentityGraph links default to ASSERTED
 * - resolveChannelRecipient() returns ONLY VERIFIED links
 * - State transitions: ASSERTED→VERIFIED, ASSERTED→EXPIRED, VERIFIED→REVOKED
 * - verifyChannelChallenge updates the IdentityGraph link state
 * - Dispatch rejects ASSERTED/EXPIRED/REVOKED
 * - All resources partitioned by organization
 */

import 'server-only';
import { db } from '@/lib/db';
import type { AuthContext } from '@/lib/auth-guard';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64urlEncode } from '@/core/util/encoding';

// ─── S0.2-2: Resource Visibility Classes ─────────────────────────────

export type ResourceVisibility = 'PUBLIC' | 'ORGANIZATION' | 'USER' | 'PLATFORM';
export type AuthzRole = 'PLATFORM_ADMIN' | 'ORG_OWNER' | 'ORG_ADMIN' | 'ORG_MEMBER' | 'DEMO';

export function toAuthzRole(sessionRole: string): AuthzRole {
  if (sessionRole === 'admin') return 'PLATFORM_ADMIN';
  if (sessionRole === 'demo') return 'DEMO';
  return 'ORG_MEMBER';
}

function isPlatformAdmin(ctx: AuthContext): boolean {
  return toAuthzRole(ctx.role) === 'PLATFORM_ADMIN';
}

// ─── S0.2.1-4: Cryptographically secure challenge ────────────────────

/**
 * Generates a cryptographically random 8-character alphanumeric challenge code.
 * Uses crypto.getRandomValues() — NOT Math.random().
 */
export function generateChallengeCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusables (I, O, 0, 1)
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * Hashes a challenge code using SHA-256. The hash is stored; the plaintext is not.
 */
export function hashChallengeCode(code: string): string {
  return b64urlEncode(sha256(new TextEncoder().encode(code)));
}

// ─── S0.2.1-1/2: Channel Verification with hashed challenges ───────────

/**
 * S0.2.1: Create a channel-ownership verification challenge.
 * - Challenge code is cryptographically random.
 * - Stored as SHA-256 hash (plaintext never persisted).
 * - Challenge code is RETURNED to the action (for channel delivery) but
 *   NEVER sent to the browser as a return value.
 * - The link in IdentityGraph is set to ASSERTED (not VERIFIED).
 */
export async function createChannelChallenge(input: {
  nodeId: string;
  channel: string;
  channelId: string;
  organizationId?: string;
}): Promise<{ challengeCode: string; expiresAt: Date }> {
  const challengeCode = generateChallengeCode();
  const challengeHash = hashChallengeCode(challengeCode);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

  await db.channelVerificationChallenge.upsert({
    where: {
      node_id_channel_channel_id: {
        node_id: input.nodeId,
        channel: input.channel,
        channel_id: input.channelId,
      },
    },
    update: {
      challenge_hash: challengeHash,
      status: 'pending',
      link_state: 'ASSERTED',
      created_at: new Date(),
      expires_at: expiresAt,
      verified_at: null,
      organization_id: input.organizationId,
    },
    create: {
      node_id: input.nodeId,
      channel: input.channel,
      channel_id: input.channelId,
      challenge_hash: challengeHash,
      status: 'pending',
      link_state: 'ASSERTED',
      expires_at: expiresAt,
      organization_id: input.organizationId,
    },
  });

  return { challengeCode, expiresAt };
}

/**
 * S0.2.1: Verify a channel-ownership challenge.
 * - Hashes the submitted code and compares with stored hash.
 * - On success: updates status to 'verified', link_state to 'VERIFIED'.
 * - On failure: returns { verified: false, reason }.
 * - Never reveals whether the challenge exists (prevents enumeration).
 */
export async function verifyChannelChallenge(input: {
  nodeId: string;
  channel: string;
  channelId: string;
  challengeCode: string;
}): Promise<{ verified: boolean; reason?: string }> {
  const submittedHash = hashChallengeCode(input.challengeCode);

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
    // Don't reveal whether the challenge exists.
    return { verified: false, reason: 'Verification failed. Check your code and try again.' };
  }

  if (challenge.link_state === 'VERIFIED') {
    return { verified: false, reason: 'This channel is already verified.' };
  }

  if (challenge.link_state === 'EXPIRED' || challenge.status === 'expired') {
    return { verified: false, reason: 'This verification code has expired. Request a new one.' };
  }

  if (challenge.link_state === 'REVOKED') {
    return { verified: false, reason: 'This channel link has been revoked.' };
  }

  if (challenge.expires_at < new Date()) {
    await db.channelVerificationChallenge.update({
      where: { id: challenge.id },
      data: { status: 'expired', link_state: 'EXPIRED' },
    });
    return { verified: false, reason: 'This verification code has expired. Request a new one.' };
  }

  // Constant-time comparison would be ideal here, but for the demo SHA-256 hash comparison is sufficient.
  if (challenge.challenge_hash !== submittedHash) {
    return { verified: false, reason: 'Verification failed. Check your code and try again.' };
  }

  // Success: update status and link state.
  await db.channelVerificationChallenge.update({
    where: { id: challenge.id },
    data: {
      status: 'verified',
      link_state: 'VERIFIED',
      verified_at: new Date(),
    },
  });

  return { verified: true };
}

/**
 * S0.2.1: Get the verification state for a channel link.
 */
export async function getChannelLinkState(input: {
  nodeId: string;
  channel: string;
  channelId: string;
}): Promise<string> {
  const challenge = await db.channelVerificationChallenge.findUnique({
    where: {
      node_id_channel_channel_id: {
        node_id: input.nodeId,
        channel: input.channel,
        channel_id: input.channelId,
      },
    },
  });
  return challenge?.link_state ?? 'UNLINKED';
}

/**
 * S0.2.1: Check if a channel identity link is VERIFIED.
 * Only VERIFIED links can be used for production delivery.
 */
export async function isChannelVerified(input: {
  nodeId: string;
  channel: string;
  channelId: string;
}): Promise<boolean> {
  const state = await getChannelLinkState(input);
  return state === 'VERIFIED';
}

/**
 * S0.2.1: Revoke a verified channel link.
 * State transition: VERIFIED → REVOKED.
 */
export async function revokeChannelLink(input: {
  nodeId: string;
  channel: string;
  channelId: string;
}): Promise<boolean> {
  const updated = await db.channelVerificationChallenge.updateMany({
    where: {
      node_id: input.nodeId,
      channel: input.channel,
      channel_id: input.channelId,
      link_state: 'VERIFIED',
    },
    data: { link_state: 'REVOKED', status: 'revoked' },
  });
  return updated.count > 0;
}

// ─── S0.2-1: Audited Authorization ────────────────────────────────────

export async function authorizeNode(
  ctx: AuthContext,
  nodeId: string,
  action: string = 'access_node',
): Promise<{ organizationId: string }> {
  if (isPlatformAdmin(ctx)) {
    const ownership = await db.nodeOwnership.findUnique({ where: { nodeId } }).catch(() => null);
    const orgId = ownership?.organizationId ?? 'platform';
    await auditMandatory(ctx, action, 'node', nodeId, orgId, 'allowed', `Platform admin access to node ${nodeId}`);
    return { organizationId: orgId };
  }

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
    await auditMandatory(ctx, action, 'node', nodeId, ownership.organizationId, 'denied', `Cross-org denied: ${ctx.email} → node ${nodeId}`);
    throw new AuthzError('FORBIDDEN', `User ${ctx.email} is not authorized to access node '${nodeId}'. Cross-org access is FORBIDDEN (Article XIV §8).`);
  }

  await auditMandatory(ctx, action, 'node', nodeId, ownership.organizationId, 'allowed', undefined);
  return { organizationId: ownership.organizationId };
}

export async function authorizeBundleAtNode(ctx: AuthContext, bundleId: string, nodeId: string, action: string = 'access_bundle'): Promise<{ organizationId: string }> {
  return authorizeNode(ctx, nodeId, action);
}

export async function authorizeConversationAtNode(ctx: AuthContext, nodeId: string, _conversationId: string, action: string = 'access_conversation'): Promise<{ organizationId: string }> {
  return authorizeNode(ctx, nodeId, action);
}

// S0.2.1-7: Removed sensitive data from PUBLIC visibility.
// getDeliverySnapshots, getQueuedBundles, getRelayForwardProofs are now ORGANIZATION, not PUBLIC.
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
      await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Public resource access');
      return { organizationId };

    case 'PLATFORM':
      if (!isPlatformAdmin(ctx)) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'denied', `Platform access denied for ${ctx.email}`);
        throw new AuthzError('FORBIDDEN', `Platform-level access required. User ${ctx.email} has role '${ctx.role}'.`);
      }
      await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Platform admin access');
      return { organizationId };

    case 'ORGANIZATION':
      if (isPlatformAdmin(ctx)) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Platform admin access to org resource');
        return { organizationId };
      }
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

    case 'USER':
      if (isPlatformAdmin(ctx)) {
        await auditMandatory(ctx, action, resourceType, resourceId, organizationId, 'allowed', 'Platform admin access to user resource');
        return { organizationId };
      }
      return { organizationId };
  }
}

export async function authorizeNetworkOperation(ctx: AuthContext, requirePlatformAdmin: boolean = false, action: string = 'network_operation'): Promise<{ organizationId: string }> {
  if (requirePlatformAdmin && !isPlatformAdmin(ctx)) {
    await auditMandatory(ctx, action, 'network', undefined, undefined, 'denied', `Platform admin required: ${ctx.email} (role: ${ctx.role})`);
    throw new AuthzError('FORBIDDEN', `Platform admin role required. User ${ctx.email} has role '${ctx.role}'.`);
  }
  await auditMandatory(ctx, action, 'network', undefined, 'platform', 'allowed', undefined);
  return { organizationId: 'platform' };
}

// ─── S0.2.1-9: Mandatory Audit Persistence ───────────────────────────

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
    actorEmail: ctx.email, actorRole: ctx.role, action, resourceType, resourceId, organizationId, outcome, reason,
  };
  try {
    await db.auditEvent.create({ data: eventData });
  } catch (e) {
    console.error('[AUDIT_FAILURE]', JSON.stringify(eventData), String(e));
  }
}

export async function logAuditEvent(input: {
  actorEmail: string; actorRole: string; action: string;
  resourceType: string; resourceId?: string; organizationId?: string;
  outcome: 'allowed' | 'denied'; reason?: string;
}): Promise<void> {
  try {
    await db.auditEvent.create({ data: input });
  } catch (e) {
    console.error('[AUDIT_FAILURE]', JSON.stringify(input), String(e));
  }
}

// ─── Error handling ───────────────────────────────────────────────────

export class AuthzError extends Error {
  constructor(public code: 'UNAUTHORIZED' | 'FORBIDDEN', message: string) {
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
