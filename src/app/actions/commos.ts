'use server';

/**
 * app/actions/commos.ts
 *
 * Server Actions that expose the Communication OS API to the Web UI.
 * The Web UI MUST NOT call adapters/matrix/transport-impl directly (ARCH-011).
 * It MUST call these actions only.
 */

import 'server-only';
import { getNetwork } from '@/server/CommOS';
import type { DispatchRequest } from '@/server/CommOS';

export async function getNetworkStateAction() {
  const net = getNetwork();
  return net.networkState();
}

export async function listNodesAction() {
  const net = getNetwork();
  return net.listNodes();
}

export async function dispatchBundleAction(req: DispatchRequest) {
  const net = getNetwork();
  return net.dispatch(req);
}

export async function getDeliverySnapshotsAction() {
  const net = getNetwork();
  return net.deliverySnapshots();
}

export async function getQueuedBundlesAction() {
  const net = getNetwork();
  return net.queuedBundles();
}

export async function tryDecryptBundleAction(bundle_id: string, at_node_id: string) {
  const net = getNetwork();
  return net.tryDecrypt(bundle_id, at_node_id);
}

export async function markReadAction(bundle_id: string, at_node_id: string) {
  const net = getNetwork();
  return net.markRead(bundle_id, at_node_id);
}

export async function resetNetworkAction() {
  const net = getNetwork();
  await net.reset();
  return { ok: true };
}

// P3 additions

export async function getRelayForwardProofsAction(bundle_id: string) {
  const net = getNetwork();
  return net.relayForwardProofs(bundle_id);
}

export async function sweepOnceAction() {
  const net = getNetwork();
  return net.sweepOnce();
}

export async function getSweeperStatusAction() {
  const net = getNetwork();
  return net.sweeperStatus();
}

// P6 additions

export async function getEmailTranscriptAction() {
  const net = getNetwork();
  return net.emailTranscriptEntries();
}

// P8: SMS + WhatsApp transcript actions

export async function getSmsTranscriptAction() {
  const net = getNetwork();
  return net.smsTranscriptEntries();
}

export async function getWhatsappTranscriptAction() {
  const net = getNetwork();
  return net.whatsappTranscriptEntries();
}

// P5 additions

export async function getCapabilityCachesAction() {
  const net = getNetwork();
  return net.capabilityCachesSnapshot();
}

export async function gossipNowAction() {
  const net = getNetwork();
  net.gossipAll();
  return { ok: true };
}

// P10 additions

export async function getIdentityGraphAction() {
  const net = getNetwork();
  return net.identityGraphSnapshot();
}

export async function linkIdentityToChannelAction(input: {
  node_id: string;
  channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'MATRIX' | 'TELEGRAM' | 'INSTAGRAM' | 'MESSENGER' | 'RCS';
  channel_id: string;
}) {
  const net = getNetwork();
  const rt = (net as any).runtimes.get(input.node_id);
  if (!rt) return { ok: false, error: `unknown node ${input.node_id}` };
  const identity = rt.identity;
  const keypair = (net as any).identities.get(input.node_id);
  if (!keypair) return { ok: false, error: `no keypair for ${input.node_id}` };
  return {
    ok: net.linkIdentityToChannel(identity, keypair, input.channel, input.channel_id),
  };
}

// P11 additions

export async function getInboxAction(node_id: string) {
  const net = getNetwork();
  return net.getInbox(node_id);
}

export async function markConversationReadAction(node_id: string, conversation_id: string) {
  const net = getNetwork();
  return net.markConversationRead(node_id, conversation_id);
}

// P12 additions

export async function getAnalyticsAction() {
  const net = getNetwork();
  return net.getAnalytics();
}

export async function getRoutingPolicyAction() {
  const net = getNetwork();
  return net.getRoutingPolicy();
}

export async function updateRoutingPolicyAction(updates: Record<string, any>) {
  const net = getNetwork();
  return net.updateRoutingPolicy(updates as any);
}

// P14 — AI (assistive, not authoritative)
// Per master prompt: AI may assist with intent interpretation, routing
// recommendations, conversation summarization. AI MUST NOT become authority
// for cryptography, identity verification, authorization, protocol semantics,
// delivery truth, security invariants.
// The AI SUGGESTS; the user CONFIRMS before dispatch.

export async function aiInterpretIntentAction(plaintext: string) {
  'use server';
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
    // Parse the JSON response.
    const jsonMatch = response.match(/\{[^}]+\}/s);
    if (!jsonMatch) {
      return { ok: false, error: 'AI did not return valid JSON', raw: response };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return { ok: true, suggestion: parsed, raw: response };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function aiSummarizeConversationAction(messages: Array<{ sender: string; plaintext: string; received_at: number }>) {
  'use server';
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
}
