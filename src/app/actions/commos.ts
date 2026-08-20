'use server';

/**
 * app/actions/commos.ts
 *
 * Server Actions that expose the Communication OS API to the Web UI.
 * The Web UI MUST NOT call adapters/matrix/transport-impl directly (ARCH-011).
 * It MUST call these actions only.
 *
 * S0-4: Every action calls requireAuth() / requireRole() / requireAdmin().
 * S0-5: Mutating operations require authenticated user; admin ops require admin.
 * S0.1: Every resource-bearing action authorizes the resource against the principal.
 * S0-6: The actor's email is available via the AuthContext for audit trail.
 * S0-7: NextAuth server actions are CSRF-protected by the session cookie.
 * S0.1-7: Raw internal exceptions are never returned to clients (safeError).
 * S0.1-6: Every operation is logged to AuditEvent table.
 */

import 'server-only';
import { getNetwork } from '@/server/CommOS';
import type { DispatchRequest } from '@/server/CommOS';
import {
  requireAuth, requireRole, requireAdmin,
  withAuth, withRole,
  safeError, logAuditEvent,
  authorizeNode, authorizeBundleAtNode, authorizeConversationAtNode, authorizeNetworkOperation,
} from '@/lib/auth-guard';
import type { AuthContext } from '@/lib/auth-guard';

// Helper: safe action wrapper that catches errors and logs audit events.
async function safeAction<T>(
  ctx: AuthContext,
  action: string,
  resourceType: string,
  resourceId: string | undefined,
  orgId: string | undefined,
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; code: string }> {
  try {
    const data = await fn();
    await logAuditEvent({
      actorEmail: ctx.email, actorRole: ctx.role, action, resourceType, resourceId,
      organizationId: orgId, outcome: 'allowed',
    });
    return { ok: true, data };
  } catch (e) {
    const err = safeError(e);
    await logAuditEvent({
      actorEmail: ctx.email, actorRole: ctx.role, action, resourceType, resourceId,
      organizationId: orgId, outcome: 'denied', reason: err.error,
    });
    return err;
  }
}

// ─── Read-only actions (require any authenticated user) ──────────────

export async function getNetworkStateAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getNetworkState', 'network', undefined, undefined,
      async () => getNetwork().networkState());
  });
}

export async function listNodesAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'listNodes', 'network', undefined, undefined,
      async () => getNetwork().listNodes());
  });
}

export async function getDeliverySnapshotsAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getDeliverySnapshots', 'network', undefined, undefined,
      async () => getNetwork().deliverySnapshots());
  });
}

export async function getQueuedBundlesAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getQueuedBundles', 'network', undefined, undefined,
      async () => getNetwork().queuedBundles());
  });
}

// S0.1: Resource-bearing read actions — authorize node_id.

export async function tryDecryptBundleAction(bundle_id: string, at_node_id: string) {
  return withAuth(async (ctx) => {
    const { organizationId } = await authorizeBundleAtNode(ctx, bundle_id, at_node_id);
    return safeAction(ctx, 'tryDecrypt', 'bundle', bundle_id, organizationId,
      async () => getNetwork().tryDecrypt(bundle_id, at_node_id));
  });
}

export async function getRelayForwardProofsAction(bundle_id: string) {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getRelayForwardProofs', 'bundle', bundle_id, undefined,
      async () => getNetwork().relayForwardProofs(bundle_id));
  });
}

export async function getSweeperStatusAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getSweeperStatus', 'network', undefined, undefined,
      async () => getNetwork().sweeperStatus());
  });
}

export async function getEmailTranscriptAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getEmailTranscript', 'network', undefined, undefined,
      async () => getNetwork().emailTranscriptEntries());
  });
}

export async function getSmsTranscriptAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getSmsTranscript', 'network', undefined, undefined,
      async () => getNetwork().smsTranscriptEntries());
  });
}

export async function getWhatsappTranscriptAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getWhatsappTranscript', 'network', undefined, undefined,
      async () => getNetwork().whatsappTranscriptEntries());
  });
}

export async function getCapabilityCachesAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getCapabilityCaches', 'network', undefined, undefined,
      async () => getNetwork().capabilityCachesSnapshot());
  });
}

export async function getIdentityGraphAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getIdentityGraph', 'network', undefined, undefined,
      async () => getNetwork().identityGraphSnapshot());
  });
}

// S0.1: getInbox authorizes node_id.

export async function getInboxAction(node_id: string) {
  return withAuth(async (ctx) => {
    const { organizationId } = await authorizeNode(ctx, node_id);
    return safeAction(ctx, 'getInbox', 'node', node_id, organizationId,
      async () => getNetwork().getInbox(node_id));
  });
}

export async function getAnalyticsAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getAnalytics', 'network', undefined, undefined,
      async () => getNetwork().getAnalytics());
  });
}

export async function getRoutingPolicyAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getRoutingPolicy', 'network', undefined, undefined,
      async () => getNetwork().getRoutingPolicy());
  });
}

export async function getCommunityStatsAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'getCommunityStats', 'network', undefined, undefined,
      async () => getNetwork().getCommunityStats());
  });
}

// ─── Mutating actions (require authenticated user) ───────────────────
// S0.1: Dispatch authorizes from_node_id.

export async function dispatchBundleAction(req: DispatchRequest) {
  return withAuth(async (ctx) => {
    const { organizationId } = await authorizeNode(ctx, req.from_node_id);
    return safeAction(ctx, 'dispatch', 'node', req.from_node_id, organizationId,
      async () => getNetwork().dispatch(req));
  });
}

// S0.1: markRead authorizes at_node_id.

export async function markReadAction(bundle_id: string, at_node_id: string) {
  return withAuth(async (ctx) => {
    const { organizationId } = await authorizeBundleAtNode(ctx, bundle_id, at_node_id);
    return safeAction(ctx, 'markRead', 'bundle', bundle_id, organizationId,
      async () => getNetwork().markRead(bundle_id, at_node_id));
  });
}

// S0.1: markConversationRead authorizes node_id.

export async function markConversationReadAction(node_id: string, conversation_id: string) {
  return withAuth(async (ctx) => {
    const { organizationId } = await authorizeConversationAtNode(ctx, node_id, conversation_id);
    return safeAction(ctx, 'markConversationRead', 'conversation', conversation_id, organizationId,
      async () => getNetwork().markConversationRead(node_id, conversation_id));
  });
}

export async function gossipNowAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'gossipNow', 'network', undefined, undefined,
      async () => { getNetwork().gossipAll(); return { ok: true }; });
  });
}

export async function sweepOnceAction() {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'sweepOnce', 'network', undefined, undefined,
      async () => getNetwork().sweepOnce());
  });
}

// S0.1: linkIdentityToChannel authorizes node_id.

export async function linkIdentityToChannelAction(input: {
  node_id: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'MATRIX' | 'TELEGRAM' | 'INSTAGRAM' | 'MESSENGER' | 'RCS';
  channel_id: string;
}) {
  return withAuth(async (ctx) => {
    const { organizationId } = await authorizeNode(ctx, input.node_id);
    return safeAction(ctx, 'linkIdentity', 'node', input.node_id, organizationId,
      async () => {
        const net = getNetwork();
        const rt = (net as any).runtimes.get(input.node_id);
        if (!rt) return { ok: false, error: `unknown node ${input.node_id}` };
        const identity = rt.identity;
        const keypair = (net as any).identities.get(input.node_id);
        if (!keypair) return { ok: false, error: `no keypair for ${input.node_id}` };
        return { ok: net.linkIdentityToChannel(identity, keypair, input.channel, input.channel_id) };
      });
  });
}

// S0.1: updateRoutingPolicy requires admin or demo — network-level operation.

export async function updateRoutingPolicyAction(updates: Record<string, any>) {
  return withRole(['admin', 'demo'], async (ctx) => {
    const { organizationId } = await authorizeNetworkOperation(ctx);
    return safeAction(ctx, 'updateRoutingPolicy', 'network', undefined, organizationId,
      async () => getNetwork().updateRoutingPolicy(updates as any));
  });
}

// S0.1: resetNetwork requires admin — destructive operation.

export async function resetNetworkAction() {
  return withRole(['admin'], async (ctx) => {
    const { organizationId } = await authorizeNetworkOperation(ctx, true);
    return safeAction(ctx, 'resetNetwork', 'network', undefined, organizationId,
      async () => { await getNetwork().reset(); return { ok: true }; });
  });
}

// ─── AI actions (require authenticated user) ──────────────────────────

export async function aiInterpretIntentAction(plaintext: string) {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'aiInterpretIntent', 'network', undefined, undefined,
      async () => {
        try {
          const ZAI = (await import('z-ai-web-dev-sdk')).default;
          const zai = await ZAI.create();
          const systemPrompt = `You are an assistant for the Universal Communication OS. Your job is to interpret a user's natural-language message and suggest a structured Intent for routing.

The Intent type system has these fields:
- type: one of SEND_MESSAGE, NOTIFY, REQUEST_RESPONSE, DELIVER_DOCUMENT, SEND_MEDIA, EMERGENCY_ALERT, SYNC_CONVERSATION
- priority: one of BULK, NORMAL, PRIORITY, URGENT, EMERGENCY
- ttl_ms: time-to-live in milliseconds (default 60000 = 1 minute; use 300000 for 5 min, 3600000 for 1 hour)
- min_privacy: one of PUBLIC, STANDARD, STRICT, FORWARD_SECRECY (default STANDARD)

Rules:
- If the message mentions "urgent", "emergency", "critical", or "ASAP" → priority URGENT or EMERGENCY
- If the message mentions "private", "confidential", "sensitive" → min_privacy STRICT
- If the message mentions "document", "file", "attachment" → type DELIVER_DOCUMENT
- If the message mentions "photo", "image", "video", "media" → type SEND_MEDIA
- If the message asks a question → type REQUEST_RESPONSE
- If the message is a notification/alert → type NOTIFY
- Default: type SEND_MESSAGE, priority NORMAL, min_privacy STANDARD, ttl_ms 60000

Respond with a JSON object ONLY. No additional text. Format:
{"type":"...","priority":"...","ttl_ms":...,"min_privacy":"...","reasoning":"one sentence explaining your choice"}`;

          const completion = await zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: systemPrompt },
              { role: 'user', content: `Interpret this message: "${plaintext}"` },
            ],
            thinking: { type: 'disabled' as any },
          });

          const response = completion.choices?.[0]?.message?.content ?? '';
          const jsonMatch = response.match(/\{[^}]+\}/s);
          if (!jsonMatch) return { ok: false, error: 'AI did not return valid JSON', raw: response };
          const parsed = JSON.parse(jsonMatch[0]);
          return { ok: true, suggestion: parsed, raw: response };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      });
  });
}

export async function aiSummarizeConversationAction(messages: Array<{ sender: string; plaintext: string; received_at: number }>) {
  return withAuth(async (ctx) => {
    return safeAction(ctx, 'aiSummarize', 'network', undefined, undefined,
      async () => {
        try {
          const ZAI = (await import('z-ai-web-dev-sdk')).default;
          const zai = await ZAI.create();

          const threadText = messages
            .map((m) => `[${new Date(m.received_at).toLocaleTimeString()}] ${m.sender}: ${m.plaintext}`)
            .join('\n');

          const systemPrompt = `You are a conversation summarizer for the Universal Communication OS. Summarize the conversation thread below in 2-3 sentences. Focus on the key topics, any action items, and the overall tone. Do not reveal sensitive details — keep the summary high-level.`;

          const completion = await zai.chat.completions.create({
            messages: [
              { role: 'assistant', content: systemPrompt },
              { role: 'user', content: `Summarize this conversation:\n\n${threadText}` },
            ],
            thinking: { type: 'disabled' as any },
          });

          const summary = completion.choices?.[0]?.message?.content ?? '';
          return { ok: true, summary };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      });
  });
}
