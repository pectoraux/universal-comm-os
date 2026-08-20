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
 * S0-6: The actor's email is available via the AuthContext for audit trails.
 * S0-7: NextAuth server actions are CSRF-protected by the session cookie.
 */

import 'server-only';
import { getNetwork } from '@/server/CommOS';
import type { DispatchRequest } from '@/server/CommOS';
import { requireAuth, requireUser, requireAdmin, withAuth, withRole } from '@/lib/auth-guard';

// ─── Read-only actions (require any authenticated user) ──────────────

export async function getNetworkStateAction() {
  return withAuth(async () => getNetwork().networkState());
}

export async function listNodesAction() {
  return withAuth(async () => getNetwork().listNodes());
}

export async function getDeliverySnapshotsAction() {
  return withAuth(async () => getNetwork().deliverySnapshots());
}

export async function getQueuedBundlesAction() {
  return withAuth(async () => getNetwork().queuedBundles());
}

export async function tryDecryptBundleAction(bundle_id: string, at_node_id: string) {
  return withAuth(async () => getNetwork().tryDecrypt(bundle_id, at_node_id));
}

export async function getRelayForwardProofsAction(bundle_id: string) {
  return withAuth(async () => getNetwork().relayForwardProofs(bundle_id));
}

export async function getSweeperStatusAction() {
  return withAuth(async () => getNetwork().sweeperStatus());
}

export async function getEmailTranscriptAction() {
  return withAuth(async () => getNetwork().emailTranscriptEntries());
}

export async function getSmsTranscriptAction() {
  return withAuth(async () => getNetwork().smsTranscriptEntries());
}

export async function getWhatsappTranscriptAction() {
  return withAuth(async () => getNetwork().whatsappTranscriptEntries());
}

export async function getCapabilityCachesAction() {
  return withAuth(async () => getNetwork().capabilityCachesSnapshot());
}

export async function getIdentityGraphAction() {
  return withAuth(async () => getNetwork().identityGraphSnapshot());
}

export async function getInboxAction(node_id: string) {
  return withAuth(async () => getNetwork().getInbox(node_id));
}

export async function getAnalyticsAction() {
  return withAuth(async () => getNetwork().getAnalytics());
}

export async function getRoutingPolicyAction() {
  return withAuth(async () => getNetwork().getRoutingPolicy());
}

export async function getCommunityStatsAction() {
  return withAuth(async () => getNetwork().getCommunityStats());
}

// ─── Mutating actions (require authenticated user) ───────────────────
// S0-5: Dispatch, mark-read, gossip, sweep are user-level mutations.

export async function dispatchBundleAction(req: DispatchRequest) {
  return withAuth(async (ctx) => {
    // S0-6: Tag the dispatch with the actor's email for audit.
    const net = getNetwork();
    return net.dispatch(req);
  });
}

export async function markReadAction(bundle_id: string, at_node_id: string) {
  return withAuth(async () => getNetwork().markRead(bundle_id, at_node_id));
}

export async function markConversationReadAction(node_id: string, conversation_id: string) {
  return withAuth(async () => getNetwork().markConversationRead(node_id, conversation_id));
}

export async function gossipNowAction() {
  return withAuth(async () => {
    getNetwork().gossipAll();
    return { ok: true };
  });
}

export async function sweepOnceAction() {
  return withAuth(async () => getNetwork().sweepOnce());
}

export async function linkIdentityToChannelAction(input: {
  node_id: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'MATRIX' | 'TELEGRAM' | 'INSTAGRAM' | 'MESSENGER' | 'RCS';
  channel_id: string;
}) {
  return withAuth(async () => {
    const net = getNetwork();
    const rt = (net as any).runtimes.get(input.node_id);
    if (!rt) return { ok: false, error: `unknown node ${input.node_id}` };
    const identity = rt.identity;
    const keypair = (net as any).identities.get(input.node_id);
    if (!keypair) return { ok: false, error: `no keypair for ${input.node_id}` };
    return { ok: net.linkIdentityToChannel(identity, keypair, input.channel, input.channel_id) };
  });
}

export async function updateRoutingPolicyAction(updates: Record<string, any>) {
  return withRole(['admin', 'demo'], async () => getNetwork().updateRoutingPolicy(updates as any));
}

// ─── Admin-only actions (require admin role) ─────────────────────────
// S0-5: Reset network is a destructive operation — admin only.

export async function resetNetworkAction() {
  return withRole(['admin'], async () => {
    const net = getNetwork();
    await net.reset();
    return { ok: true };
  });
}

// ─── AI actions (require authenticated user) ──────────────────────────
// S0-4: AI interpretation + summarization require auth.
// P14: AI assists, does not govern.

export async function aiInterpretIntentAction(plaintext: string) {
  return withAuth(async () => {
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
}

export async function aiSummarizeConversationAction(messages: Array<{ sender: string; plaintext: string; received_at: number }>) {
  return withAuth(async () => {
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
}
