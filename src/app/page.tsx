'use client';

/**
 * app/page.tsx — Communication OS Console (Web Client, P0+P1+P2 visible surface).
 *
 * The Web UI is a CONSUMER of the Communication OS API (Architecture Constitution
 * Article I.6 + Article VI). It MUST NOT call adapters/matrix/transport-impl
 * directly. It calls only the server actions in `app/actions/commos.ts`.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getNetworkStateAction,
  listNodesAction,
  dispatchBundleAction,
  getDeliverySnapshotsAction,
  getQueuedBundlesAction,
  tryDecryptBundleAction,
  markReadAction,
  resetNetworkAction,
  getRelayForwardProofsAction,
  sweepOnceAction,
  getSweeperStatusAction,
  getEmailTranscriptAction,
  getSmsTranscriptAction,
  getWhatsappTranscriptAction,
  getCapabilityCachesAction,
  gossipNowAction,
  getIdentityGraphAction,
  linkIdentityToChannelAction,
  getInboxAction,
  markConversationReadAction,
  getAnalyticsAction,
  getRoutingPolicyAction,
  updateRoutingPolicyAction,
  aiInterpretIntentAction,
  aiSummarizeConversationAction,
} from '@/app/actions/commos';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Toaster } from '@/components/ui/toaster';
import { useToast } from '@/hooks/use-toast';
import {
  Activity,
  Boxes,
  Network,
  Package,
  Radio,
  Send,
  Settings2,
  ShieldCheck,
  FileText,
  Workflow,
  KeyRound,
  Clock,
  CheckCircle2,
  XCircle,
  RefreshCw,
  GitBranch,
  Layers,
  Server,
  Users,
  Link2,
  Inbox,
  Mail,
  BarChart3,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NodeDescriptor {
  node_id: string;
  display_name: string;
  roles: string[];
  capabilities: any;
  identity: any;
  peers: string[];
}

interface NetworkState {
  nodes: Array<{ node_id: string; display_name: string; roles: string[] }>;
  links: Array<{ from: string; to: string; transport: string }>;
  capabilities: Record<string, any>;
}

interface DeliverySnapshot {
  bundle_id: string;
  node_id?: string; // P3: per-node delivery state
  current: string;
  history: Array<{ ts: number; from?: string; to: string; node?: string; transport?: string; note?: string }>;
  updated_at: number;
}

interface QueuedBundle {
  node_id: string;
  bundle_id: string;
  queued_at: number;
  nextHop: string;
}

interface DispatchResponse {
  status: 'DISPATCHED' | 'QUEUED' | 'NO_ROUTE' | 'BUNDLE_EXPIRED' | 'ERROR';
  bundle_id?: string;
  route_plan?: {
    hops: Array<{
      kind: string;
      to_node_id?: string;
      transport?: string;
      gateway?: string;
      est_reliability?: number;
      est_latency_ms?: number;
      est_cost?: number;
    }>;
    rationale: string;
    est_reliability: number;
    est_latency_ms: number;
    est_cost: number;
  };
  error?: string;
}

const STATE_COLORS: Record<string, string> = {
  CREATED: 'bg-slate-500',
  ACCEPTED: 'bg-blue-500',
  QUEUED: 'bg-amber-500',
  RELAYED: 'bg-cyan-500',
  GATEWAY_REACHED: 'bg-purple-500',
  EXTERNAL_ACCEPTED: 'bg-fuchsia-500',
  DELIVERED: 'bg-emerald-500',
  READ: 'bg-green-600',
  EXPIRED: 'bg-red-700',
  REJECTED: 'bg-red-500',
  POLICY_BLOCKED: 'bg-orange-600',
  NO_ROUTE: 'bg-red-800',
  CHANNEL_UNAVAILABLE: 'bg-orange-500',
  GATEWAY_UNAVAILABLE: 'bg-orange-700',
  DESTINATION_UNKNOWN: 'bg-red-600',
};

export default function Home() {
  const { toast } = useToast();
  const [network, setNetwork] = useState<NetworkState | null>(null);
  const [nodes, setNodes] = useState<NodeDescriptor[]>([]);
  const [delivery, setDelivery] = useState<DeliverySnapshot[]>([]);
  const [queues, setQueues] = useState<QueuedBundle[]>([]);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [lastDispatch, setLastDispatch] = useState<DispatchResponse | null>(null);
  const [decryptResult, setDecryptResult] = useState<{ ok: boolean; plaintext?: string; reason?: string } | null>(null);
  const [proofsView, setProofsView] = useState<{ bundle_id: string; proofs: Array<{ kind: string; signer_id: string; ts: number; verified: boolean }> } | null>(null);
  const [sweeperStatus, setSweeperStatus] = useState<{ running: boolean; last?: { expired_count: number; ts: number } } | null>(null);
  const [emailTranscript, setEmailTranscript] = useState<Array<{ message_id: string; to: string; from: string; subject: string; body: string; sent_at: number; bundle_id: string }>>([]);
  const [smsTranscript, setSmsTranscript] = useState<Array<any>>([]);
  const [whatsappTranscript, setWhatsappTranscript] = useState<Array<any>>([]);
  const [capabilityCaches, setCapabilityCaches] = useState<Array<{ node_id: string; entries: Array<any> }>>([]);
  const [identityGraph, setIdentityGraph] = useState<Array<any>>([]);
  const [inbox, setInbox] = useState<Array<{ conversation_id: string; messages: Array<any>; unread_count: number }>>([]);
  const [inboxNode, setInboxNode] = useState('bob');
  const [analytics, setAnalytics] = useState<any>(null);
  const [routingPolicy, setRoutingPolicy] = useState<any>(null);
  const [aiSuggestion, setAiSuggestion] = useState<{ ok: boolean; suggestion?: any; reasoning?: string; error?: string } | null>(null);
  const [aiSummary, setAiSummary] = useState<{ conversation_id: string; summary: string } | null>(null);

  const [fromNode, setFromNode] = useState('alice');
  const [toNode, setToNode] = useState('bob');
  /** P6: 'identity' (to_node_id) or 'channel' (to_channel). */
  const [recipientMode, setRecipientMode] = useState<'identity' | 'email' | 'sms' | 'whatsapp'>('identity');
  const [toEmail, setToEmail] = useState('bob@example.com');
  const [intentType, setIntentType] = useState<'SEND_MESSAGE' | 'NOTIFY' | 'REQUEST_RESPONSE' | 'DELIVER_DOCUMENT' | 'SEND_MEDIA' | 'EMERGENCY_ALERT' | 'SYNC_CONVERSATION'>('SEND_MESSAGE');
  const [priority, setPriority] = useState<'BULK' | 'NORMAL' | 'PRIORITY' | 'URGENT' | 'EMERGENCY'>('NORMAL');
  const [plaintext, setPlaintext] = useState('Hello from offline-first fabric — encrypted end-to-end, relayed without Internet.');
  const [replicate, setReplicate] = useState(false);

  const refresh = useCallback(async () => {
    const [n, ns, dl, q, ss, et, cc, ig, ib, an, rp, st, wt] = await Promise.all([
      getNetworkStateAction(),
      listNodesAction(),
      getDeliverySnapshotsAction(),
      getQueuedBundlesAction(),
      getSweeperStatusAction(),
      getEmailTranscriptAction(),
      getCapabilityCachesAction(),
      getIdentityGraphAction(),
      getInboxAction(inboxNode),
      getAnalyticsAction(),
      getRoutingPolicyAction(),
      getSmsTranscriptAction(),
      getWhatsappTranscriptAction(),
    ]);
    setTimeout(() => {
      setNetwork(n);
      setNodes(ns as NodeDescriptor[]);
      Promise.resolve(dl).then((d) => setDelivery(d));
      Promise.resolve(q).then((qq) => setQueues(qq));
      setSweeperStatus(ss as any);
      setEmailTranscript(et as any);
      setCapabilityCaches(cc as any);
      setIdentityGraph(ig as any);
      Promise.resolve(ib).then((i) => setInbox(i as any));
      Promise.resolve(an).then((a) => setAnalytics(a));
      Promise.resolve(rp).then((p) => setRoutingPolicy(p));
      Promise.resolve(st).then((s) => setSmsTranscript(s));
      Promise.resolve(wt).then((w) => setWhatsappTranscript(w));
    }, 0);
  }, [inboxNode]);

  useEffect(() => {
    // Initial load (NOT setState in effect body — wrapped in setTimeout via refresh).
    const id = setInterval(refresh, 1500);
    void refresh();
    return () => clearInterval(id);
  }, [refresh]);

  const onDispatch = useCallback(async () => {
    if (recipientMode === 'identity' && fromNode === toNode) {
      toast({ title: 'Sender and recipient are the same', variant: 'destructive' });
      return;
    }
    const req: any = {
      from_node_id: fromNode,
      plaintext,
      intent_type: intentType,
      priority,
      replicate,
    };
    if (recipientMode === 'identity') {
      req.to_node_id = toNode;
    } else {
      req.to_channel = { channel: recipientMode.toUpperCase() as any, channel_id: toEmail };
    }
    const res = await dispatchBundleAction(req);
    setLastDispatch(res);
    if (res.status === 'DISPATCHED' || res.status === 'QUEUED') {
      toast({
        title: `Bundle ${res.status.toLowerCase()}`,
        description: res.replicas_sent
          ? `Replicated to ${res.replicas_sent} peer(s) — first delivery wins.`
          : res.route_plan
            ? `${res.route_plan.hops.length} hop(s): ${res.route_plan.rationale.slice(0, 80)}...`
            : 'Queued for later delivery (DTN semantics).',
      });
      if (res.bundle_id) setSelectedBundleId(res.bundle_id);
    } else {
      toast({
        title: `Dispatch failed: ${res.status}`,
        description: res.error,
        variant: 'destructive',
      });
    }
    await refresh();
  }, [fromNode, toNode, toEmail, recipientMode, plaintext, intentType, priority, replicate, toast, refresh]);

  const onTryDecrypt = useCallback(async () => {
    if (!selectedBundleId) return;
    const res = await tryDecryptBundleAction(selectedBundleId, toNode);
    setDecryptResult(res);
    if (res.ok) {
      toast({ title: 'Decrypted', description: `Recipient opened the bundle. Plaintext: ${res.plaintext?.slice(0, 60)}...` });
    } else {
      toast({ title: 'Cannot decrypt', description: res.reason, variant: 'destructive' });
    }
    await refresh();
  }, [selectedBundleId, toNode, toast, refresh]);

  const onMarkRead = useCallback(async () => {
    if (!selectedBundleId) return;
    const res = await markReadAction(selectedBundleId, toNode);
    if (res.ok) {
      toast({ title: 'Marked READ' });
    } else {
      toast({ title: 'Could not mark READ', description: res.reason, variant: 'destructive' });
    }
    await refresh();
  }, [selectedBundleId, toNode, toast, refresh]);

  const onSweepOnce = useCallback(async () => {
    const res = await sweepOnceAction();
    toast({
      title: `TTL sweep ran`,
      description: `Expired ${res.expired_count} bundle(s).`,
    });
    await refresh();
  }, [toast, refresh]);

  const onViewProofs = useCallback(async () => {
    if (!selectedBundleId) return;
    const res = await getRelayForwardProofsAction(selectedBundleId);
    setProofsView(res ?? null);
    if (res) {
      const relayCount = res.proofs.filter((p) => p.kind === 'RELAY_FORWARD').length;
      toast({
        title: `Proof chain`,
        description: `${res.proofs.length} proof(s): 1 sender + ${relayCount} relay forward(s)`,
      });
    }
  }, [selectedBundleId, toast]);

  const onGossipNow = useCallback(async () => {
    await gossipNowAction();
    toast({ title: `Gossip round executed`, description: `Each node pushed its capability advertisement to direct peers.` });
    await refresh();
  }, [toast, refresh]);

  const onLinkIdentity = useCallback(async (node_id: string, channel_id: string) => {
    const res = await linkIdentityToChannelAction({ node_id, channel: 'EMAIL', channel_id });
    if (res.ok) {
      toast({ title: `Identity linked`, description: `${node_id} now owns ${channel_id} (signed CHANNEL_OWNERSHIP proof).` });
    } else {
      toast({ title: `Link failed`, description: res.error, variant: 'destructive' });
    }
    await refresh();
  }, [toast, refresh]);

  const onMarkConversationRead = useCallback(async (conversation_id: string) => {
    const res = await markConversationReadAction(inboxNode, conversation_id);
    if (res.ok) {
      toast({ title: `Marked ${res.marked} message(s) as read` });
    }
    await refresh();
  }, [inboxNode, toast, refresh]);

  const onUpdatePolicy = useCallback(async (updates: Record<string, any>) => {
    const res = await updateRoutingPolicyAction(updates);
    toast({ title: `Routing policy updated`, description: `Changes affect subsequent dispatches only.` });
    await refresh();
  }, [toast, refresh]);

  // P14: AI-assistive features (not authoritative — the user confirms)
  const onAiInterpretIntent = useCallback(async () => {
    setAiSuggestion({ ok: false } as any); // loading
    const res = await aiInterpretIntentAction(plaintext);
    setAiSuggestion(res);
    if (res.ok && res.suggestion) {
      toast({
        title: `AI suggests: ${res.suggestion.type}`,
        description: res.suggestion.reasoning ?? 'Review the suggestion and accept to apply.',
      });
    } else {
      toast({ title: `AI interpretation failed`, description: res.error, variant: 'destructive' });
    }
  }, [plaintext, toast]);

  const onAcceptAiSuggestion = useCallback(() => {
    if (!aiSuggestion?.suggestion) return;
    const s = aiSuggestion.suggestion;
    if (s.type) setIntentType(s.type);
    if (s.priority) setPriority(s.priority);
    toast({ title: `AI suggestion applied`, description: `Intent: ${s.type}, Priority: ${s.priority}` });
    setAiSuggestion(null);
  }, [aiSuggestion, toast]);

  const onAiSummarize = useCallback(async (conversation_id: string) => {
    const conv = inbox.find((c) => c.conversation_id === conversation_id);
    if (!conv || conv.messages.length === 0) return;
    setAiSummary({ conversation_id, summary: 'Summarizing...' });
    const messages = conv.messages.map((m: any) => ({
      sender: m.sender?.display_name ?? m.sender?.id?.slice(0, 8) ?? 'unknown',
      plaintext: m.plaintext,
      received_at: m.received_at,
    }));
    const res = await aiSummarizeConversationAction(messages);
    if (res.ok) {
      setAiSummary({ conversation_id, summary: res.summary });
      toast({ title: `AI summary generated` });
    } else {
      setAiSummary(null);
      toast({ title: `AI summary failed`, description: res.error, variant: 'destructive' });
    }
  }, [inbox, toast]);

  const onReset = useCallback(async () => {
    await resetNetworkAction();
    setSelectedBundleId(null);
    setLastDispatch(null);
    setDecryptResult(null);
    setProofsView(null);
    await refresh();
    toast({ title: 'Network reset' });
  }, [refresh, toast]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <Header />
      <main className="flex-1 container mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-6">
          <ArchitectureHeader />
          <DispatchComposer
            fromNode={fromNode}
            setFromNode={setFromNode}
            toNode={toNode}
            setToNode={setToNode}
            recipientMode={recipientMode}
            setRecipientMode={setRecipientMode}
            toEmail={toEmail}
            setToEmail={setToEmail}
            intentType={intentType}
            setIntentType={setIntentType}
            priority={priority}
            setPriority={setPriority}
            plaintext={plaintext}
            setPlaintext={setPlaintext}
            replicate={replicate}
            setReplicate={setReplicate}
            nodes={nodes}
            onDispatch={onDispatch}
            lastDispatch={lastDispatch}
          />
          {/* P14: AI assistive layer — interprets intent, summarizes conversations */}
          {aiSuggestion && (
            <div className="rounded-lg border border-purple-700/50 bg-purple-950/20 p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-purple-400">
                <Sparkles className="w-3.5 h-3.5" />
                AI Intent Suggestion (P14 — assistive, not authoritative)
              </div>
              {aiSuggestion.ok && aiSuggestion.suggestion ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-mono">
                    <div><span className="text-slate-500">Type:</span> <span className="text-purple-300">{aiSuggestion.suggestion.type}</span></div>
                    <div><span className="text-slate-500">Priority:</span> <span className="text-purple-300">{aiSuggestion.suggestion.priority}</span></div>
                    <div><span className="text-slate-500">TTL:</span> <span className="text-purple-300">{aiSuggestion.suggestion.ttl_ms}ms</span></div>
                    <div><span className="text-slate-500">Privacy:</span> <span className="text-purple-300">{aiSuggestion.suggestion.min_privacy}</span></div>
                  </div>
                  {aiSuggestion.suggestion.reasoning && (
                    <p className="text-xs text-slate-400 italic">{aiSuggestion.suggestion.reasoning}</p>
                  )}
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={onAcceptAiSuggestion} className="border-purple-600 text-purple-300 hover:bg-purple-950 h-7 text-xs">
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Accept suggestion
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setAiSuggestion(null)} className="border-slate-600 text-slate-400 hover:bg-slate-800 h-7 text-xs">
                      Dismiss
                    </Button>
                  </div>
                </div>
              ) : !aiSuggestion.ok && !aiSuggestion.suggestion ? (
                <div className="text-xs text-slate-500">Analyzing message...</div>
              ) : (
                <div className="text-xs text-red-400">{aiSuggestion.error}</div>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onAiInterpretIntent}
              className="border-purple-600 text-purple-300 hover:bg-purple-950"
            >
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              AI Interpret Intent (P14)
            </Button>
            <span className="text-[10px] text-slate-500">
              The LLM analyzes your message and suggests a structured Intent. You confirm before dispatch — AI never governs routing, crypto, or delivery.
            </span>
          </div>
          <NetworkTopology network={network} nodes={nodes} />
          <CapabilityCacheCard caches={capabilityCaches} onGossipNow={onGossipNow} />
          <IdentityGraphCard graph={identityGraph} nodes={nodes} onLinkIdentity={onLinkIdentity} />
          <DtnStatusCard sweeperStatus={sweeperStatus} onSweepOnce={onSweepOnce} queues={queues} />
          <EmailTranscriptCard transcript={emailTranscript} smsTranscript={smsTranscript} whatsappTranscript={whatsappTranscript} />
          <InboxCard
            inbox={inbox}
            inboxNode={inboxNode}
            setInboxNode={setInboxNode}
            nodes={nodes}
            onMarkRead={onMarkConversationRead}
            aiSummary={aiSummary}
            onAiSummarize={onAiSummarize}
          />
          <AnalyticsCard analytics={analytics} />
          <RoutingPolicyCard policy={routingPolicy} onUpdate={onUpdatePolicy} />
          <DeliveryTimeline
            delivery={delivery}
            queues={queues}
            selectedBundleId={selectedBundleId}
            onSelect={setSelectedBundleId}
            decryptResult={decryptResult}
            onTryDecrypt={onTryDecrypt}
            onMarkRead={onMarkRead}
            onViewProofs={onViewProofs}
            proofsView={proofsView}
            toNode={toNode}
          />
        </section>
        <aside className="space-y-6">
          <ArchitectureCard />
          <GovernanceCard />
          <RoadmapCard />
          <ThreatModelCard />
        </aside>
      </main>
      <Footer onReset={onReset} />
      <Toaster />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center">
            <Workflow className="w-5 h-5 text-slate-950" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Universal Communication OS</h1>
            <p className="text-xs text-slate-400">Communication independent of the network carrying it.</p>
          </div>
        </div>
        <Badge variant="outline" className="border-emerald-500 text-emerald-400">
          P0 · P1 · P2 · P3 · P5 · P6 · P8 · P9 · P10 · P11 · P12 · P14 live
        </Badge>
      </div>
    </header>
  );
}

function ArchitectureHeader() {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="w-4 h-4 text-emerald-400" />
          The Three Fundamental Protocol Primitives
        </CardTitle>
        <CardDescription className="text-slate-400">
          Universal Identity · Intent · Communication Bundle. The Bundle is the only routable object.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <PrimitiveCard
            icon={<KeyRound className="w-4 h-4" />}
            name="UniversalIdentity"
            description="Transport-independent. Channel identities (Matrix, Email, WhatsApp…) are attached, NOT primary."
          />
          <PrimitiveCard
            icon={<Send className="w-4 h-4" />}
            name="Intent"
            description="Sender expresses WHAT. Constraints (priority, TTL, latency, privacy). Never selects transport."
          />
          <PrimitiveCard
            icon={<Package className="w-4 h-4" />}
            name="CommunicationBundle"
            description="Self-contained, encrypted, forwardable, store-and-forward. Survives partition."
          />
        </div>
      </CardContent>
    </Card>
  );
}

function PrimitiveCard({ icon, name, description }: { icon: React.ReactNode; name: string; description: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-emerald-400">{icon}</div>
        <span className="font-mono text-sm font-medium text-slate-200">{name}</span>
      </div>
      <p className="text-xs text-slate-400 leading-relaxed">{description}</p>
    </div>
  );
}

function DispatchComposer(props: {
  fromNode: string;
  setFromNode: (s: string) => void;
  toNode: string;
  setToNode: (s: string) => void;
  recipientMode: 'identity' | 'email' | 'sms' | 'whatsapp';
  setRecipientMode: (m: 'identity' | 'email' | 'sms' | 'whatsapp') => void;
  toEmail: string;
  setToEmail: (s: string) => void;
  intentType: string;
  setIntentType: (s: any) => void;
  priority: string;
  setPriority: (s: any) => void;
  plaintext: string;
  setPlaintext: (s: string) => void;
  replicate: boolean;
  setReplicate: (b: boolean) => void;
  nodes: NodeDescriptor[];
  onDispatch: () => void;
  lastDispatch: DispatchResponse | null;
}) {
  const {
    fromNode,
    setFromNode,
    toNode,
    setToNode,
    recipientMode,
    setRecipientMode,
    toEmail,
    setToEmail,
    intentType,
    setIntentType,
    priority,
    setPriority,
    plaintext,
    setPlaintext,
    replicate,
    setReplicate,
    nodes,
    onDispatch,
    lastDispatch,
  } = props;

  const intentOptions = ['SEND_MESSAGE', 'NOTIFY', 'REQUEST_RESPONSE', 'DELIVER_DOCUMENT', 'SEND_MEDIA', 'EMERGENCY_ALERT', 'SYNC_CONVERSATION'];
  const priorityOptions = ['BULK', 'NORMAL', 'PRIORITY', 'URGENT', 'EMERGENCY'];

  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="w-4 h-4 text-cyan-400" />
          Compose Intent
        </CardTitle>
        <CardDescription className="text-slate-400">
          The application says &quot;deliver this&quot; — never &quot;call WhatsApp API&quot;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="from" className="text-xs uppercase tracking-wider text-slate-400">Sender</Label>
            <Select value={fromNode} onValueChange={setFromNode}>
              <SelectTrigger id="from">
                <SelectValue placeholder="Pick sender" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n) => (
                  <SelectItem key={n.node_id} value={n.node_id}>
                    {n.display_name} ({n.roles.join(', ')})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-slate-400">Recipient</Label>
              <div className="flex gap-1 flex-wrap">
                <Button
                  size="sm"
                  variant={recipientMode === 'identity' ? 'default' : 'outline'}
                  onClick={() => setRecipientMode('identity')}
                  className="h-6 px-2 text-[10px]"
                >
                  Identity
                </Button>
                <Button
                  size="sm"
                  variant={recipientMode === 'email' ? 'default' : 'outline'}
                  onClick={() => setRecipientMode('email')}
                  className="h-6 px-2 text-[10px]"
                >
                  Email (P6)
                </Button>
                <Button
                  size="sm"
                  variant={recipientMode === 'sms' ? 'default' : 'outline'}
                  onClick={() => setRecipientMode('sms')}
                  className="h-6 px-2 text-[10px]"
                >
                  SMS (P8)
                </Button>
                <Button
                  size="sm"
                  variant={recipientMode === 'whatsapp' ? 'default' : 'outline'}
                  onClick={() => setRecipientMode('whatsapp')}
                  className="h-6 px-2 text-[10px]"
                >
                  WhatsApp (P8)
                </Button>
              </div>
            </div>
            {recipientMode === 'identity' ? (
              <Select value={toNode} onValueChange={setToNode}>
                <SelectTrigger id="to">
                  <SelectValue placeholder="Pick recipient" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.node_id} value={n.node_id}>
                      {n.display_name} ({n.roles.join(', ')})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="space-y-1.5">
                <input
                  type="email"
                  value={toEmail}
                  onChange={(e) => setToEmail(e.target.value)}
                  placeholder="recipient@example.com"
                  className="w-full h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <p className="text-[10px] text-slate-500">
                  Bundle routed via offline edge → relay → gateway (EMAIL) → external email inbox.
                  End-to-end encrypted to a key derived from the email address (demo).
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Intent Type</Label>
            <Select value={intentType} onValueChange={setIntentType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intentOptions.map((i) => (
                  <SelectItem key={i} value={i}>{i}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {priorityOptions.map((p) => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="plaintext" className="text-xs uppercase tracking-wider text-slate-400">Plaintext (encrypted end-to-end before dispatch)</Label>
          <Textarea
            id="plaintext"
            value={plaintext}
            onChange={(e) => setPlaintext(e.target.value)}
            className="min-h-[80px] font-mono text-sm bg-slate-950 border-slate-700"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={onDispatch} className="bg-emerald-600 hover:bg-emerald-500">
            <Send className="w-4 h-4 mr-2" /> Dispatch Bundle
          </Button>
          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
            <Switch checked={replicate} onCheckedChange={setReplicate} />
            <Layers className="w-3.5 h-3.5 text-amber-400" />
            <span>Replicate to N relays <span className="text-slate-500">(P3.4)</span></span>
          </label>
          <span className="text-xs text-slate-400 hidden md:inline">
            Bundle is end-to-end encrypted to recipient&apos;s X25519 key. Relay cannot decrypt.
          </span>
        </div>

        {lastDispatch && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <div className="flex items-center gap-2 mb-2">
              {lastDispatch.status === 'DISPATCHED' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : (
                <XCircle className="w-4 h-4 text-red-400" />
              )}
              <span className="font-mono text-sm">{lastDispatch.status}</span>
              {lastDispatch.replicas_sent !== undefined && lastDispatch.replicas_sent > 0 && (
                <Badge variant="outline" className="border-amber-500 text-amber-400 text-[10px]">
                  <Layers className="w-3 h-3 mr-1" />
                  {lastDispatch.replicas_sent} replica(s) sent
                </Badge>
              )}
              {lastDispatch.bundle_id && (
                <span className="text-xs text-slate-500 font-mono truncate">
                  bundle_id: {lastDispatch.bundle_id.slice(0, 18)}…
                </span>
              )}
            </div>
            {lastDispatch.route_plan && (
              <div className="text-xs text-slate-400 space-y-1">
                <div className="font-mono">
                  Route: {lastDispatch.route_plan.hops
                    .map((h) => h.to_node_id ?? '?')
                    .join(' → ')}
                </div>
                <div>
                  est. reliability {(lastDispatch.route_plan.est_reliability * 100).toFixed(1)}% · latency {lastDispatch.route_plan.est_latency_ms}ms · cost {lastDispatch.route_plan.est_cost}
                </div>
                <div className="italic">{lastDispatch.route_plan.rationale}</div>
              </div>
            )}
            {lastDispatch.error && (
              <div className="text-xs text-red-400 mt-1">{lastDispatch.error}</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CapabilityCacheCard({
  caches,
  onGossipNow,
}: {
  caches: Array<{ node_id: string; entries: Array<any> }>;
  onGossipNow: () => void;
}) {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="w-4 h-4 text-amber-400" />
          Capability Cache (P5 — gossiped view)
        </CardTitle>
        <CardDescription className="text-slate-400">
          Each node&apos;s deep view of the network. Populated by periodic capability gossip over local transports. Lets the router plan multi-hop routes proactively (e.g., A → B → C → D).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onGossipNow} className="border-amber-600 text-amber-300 hover:bg-amber-950">
            <Radio className="w-3 h-3 mr-1" /> Run Gossip Round
          </Button>
          <span className="text-[10px] text-slate-500 font-mono">
            Auto-gossip every 5s. Router uses deep cache for multi-hop BFS.
          </span>
        </div>
        {caches.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No caches loaded yet.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {caches.map((c) => (
              <div key={c.node_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <Badge variant="outline" className="border-amber-500 text-amber-400 text-[10px] font-mono">
                    <Server className="w-2.5 h-2.5 mr-1" />
                    {c.node_id}
                  </Badge>
                  <span className="text-[10px] text-slate-500">{c.entries.length} entries</span>
                </div>
                <div className="space-y-1">
                  {c.entries.length === 0 ? (
                    <div className="text-[10px] text-slate-600 italic">empty (cold start)</div>
                  ) : (
                    c.entries.map((e) => (
                      <div key={e.origin_node_id} className="text-[10px] font-mono flex items-center gap-2">
                        <span className="text-slate-300">{e.origin_node_id}</span>
                        <span className="text-slate-500">hops: {e.hop_count}</span>
                        <span className="text-slate-600">via {e.path.join('→')}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function IdentityGraphCard({
  graph,
  nodes,
  onLinkIdentity,
}: {
  graph: Array<any>;
  nodes: NodeDescriptor[];
  onLinkIdentity: (node_id: string, channel_id: string) => void;
}) {
  const [linkNodeId, setLinkNodeId] = useState('alice');
  const [linkEmail, setLinkEmail] = useState('alice@personal.example');

  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="w-4 h-4 text-emerald-400" />
          Identity Graph (P10 — channel → UniversalIdentity)
        </CardTitle>
        <CardDescription className="text-slate-400">
          Each linked channel identity is bound to a UniversalIdentity via a signed <code>CHANNEL_OWNERSHIP</code> proof. Senders resolve the recipient&apos;s real pubkey via the graph — no more synthesized keys.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {graph.length === 0 ? (
          <div className="text-sm text-slate-500 italic">No identities linked yet.</div>
        ) : (
          <div className="space-y-2">
            {graph.map((entry) => (
              <div key={`${entry.channel}:${entry.channel_id}`} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-emerald-500 text-emerald-400 text-[10px] font-mono">
                      <Link2 className="w-2.5 h-2.5 mr-1" />
                      {entry.channel}:{entry.channel_id}
                    </Badge>
                    <span className="text-[10px] text-slate-500">→</span>
                    <Badge variant="outline" className="border-cyan-500 text-cyan-400 text-[10px] font-mono">
                      {entry.identity_ref.display_name ?? entry.identity_ref.id.slice(0, 12)}
                    </Badge>
                  </div>
                  <Badge variant="outline" className="border-emerald-500 text-emerald-400 text-[10px]">
                    <ShieldCheck className="w-2.5 h-2.5 mr-1" />
                    {entry.verification}
                  </Badge>
                </div>
                <div className="text-[10px] font-mono text-slate-500 space-y-0.5">
                  <div>identity_id: <span className="text-slate-400">{entry.identity_ref.id.slice(0, 24)}…</span></div>
                  <div>signing_pubkey_hash: <span className="text-slate-400">{entry.identity_ref.signing_pubkey_hash.slice(0, 16)}…</span></div>
                  <div>linked_at: <span className="text-slate-400">{new Date(entry.linked_at).toLocaleString()}</span></div>
                  <div>proof.ts: <span className="text-slate-400">{new Date(entry.proof.ts).toLocaleString()}</span></div>
                </div>
              </div>
            ))}
          </div>
        )}

        <Separator className="bg-slate-800" />

        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wider text-slate-400">Link a new identity (demo)</div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-end">
            <div>
              <Label className="text-[10px] text-slate-500">Node</Label>
              <Select value={linkNodeId} onValueChange={setLinkNodeId}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.node_id} value={n.node_id}>{n.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px] text-slate-500">Email</Label>
              <input
                type="email"
                value={linkEmail}
                onChange={(e) => setLinkEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onLinkIdentity(linkNodeId, linkEmail)}
              className="border-emerald-600 text-emerald-400 hover:bg-emerald-950 h-8"
            >
              <Link2 className="w-3 h-3 mr-1" /> Link
            </Button>
          </div>
          <p className="text-[10px] text-slate-500">
            In production, the user&apos;s email client signs the proof locally. The demo signs it using the node&apos;s signing key (the runtime has the key).
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function NetworkTopology({ network, nodes }: { network: NetworkState | null; nodes: NodeDescriptor[] }) {
  if (!network) return null;
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="w-4 h-4 text-cyan-400" />
          Network Topology & Capability Advertisement
        </CardTitle>
        <CardDescription className="text-slate-400">
          Routing reasons over CAPABILITIES, not device types. A node is NOT a gateway merely because it has Internet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {nodes.map((n) => (
            <NodeCapCard key={n.node_id} node={n} />
          ))}
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Advertised Links</div>
          <div className="space-y-1">
            {network.links.map((l, i) => (
              <div key={i} className="text-xs font-mono text-slate-300">
                <Badge variant="outline" className="border-emerald-500 text-emerald-400 mr-2">{l.transport}</Badge>
                {l.from} ↔ {l.to}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NodeCapCard({ node }: { node: NodeDescriptor }) {
  const c = node.capabilities;
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{node.display_name}</span>
        </div>
        <div className="flex gap-1">
          {node.roles.map((r) => (
            <Badge key={r} variant="outline" className="text-[10px] border-cyan-500 text-cyan-400">{r}</Badge>
          ))}
        </div>
      </div>
      <div className="space-y-1.5 text-xs">
        <CapRow label="messaging" items={Array.from(c.messaging)} color="emerald" />
        <CapRow label="transport" items={Array.from(c.transport)} color="cyan" />
        <CapRow label="relay" items={Array.from(c.relay)} color="amber" />
        <CapRow label="gateway" items={Array.from(c.gateway)} color="purple" />
        <div className="text-slate-500 mt-1">
          verification: <span className="text-slate-300">{c.verification}</span>
        </div>
      </div>
    </div>
  );
}

function CapRow({ label, items, color }: { label: string; items: string[]; color: string }) {
  const colorClass: Record<string, string> = {
    emerald: 'border-emerald-500 text-emerald-400',
    cyan: 'border-cyan-500 text-cyan-400',
    amber: 'border-amber-500 text-amber-400',
    purple: 'border-purple-500 text-purple-400',
  };
  return (
    <div className="flex items-start gap-2">
      <span className="text-slate-500 w-20 shrink-0">{label}</span>
      <div className="flex flex-wrap gap-1">
        {items.length === 0 ? (
          <span className="text-slate-600">∅</span>
        ) : (
          items.map((i) => (
            <Badge key={i} variant="outline" className={cn('text-[10px]', colorClass[color])}>{i}</Badge>
          ))
        )}
      </div>
    </div>
  );
}

function DtnStatusCard({
  sweeperStatus,
  onSweepOnce,
  queues,
}: {
  sweeperStatus: { running: boolean; last?: { expired_count: number; ts: number } } | null;
  onSweepOnce: () => void;
  queues: QueuedBundle[];
}) {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="w-4 h-4 text-purple-400" />
          DTN Status
        </CardTitle>
        <CardDescription className="text-slate-400">
          Persistent bundle store · TTL sweeper · Dedup index · Replication fan-out.
          Survives process restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <StatBlock
            label="TTL Sweeper"
            value={sweeperStatus?.running ? 'RUNNING' : 'STOPPED'}
            color={sweeperStatus?.running ? 'emerald' : 'slate'}
          />
          <StatBlock
            label="Queued Bundles"
            value={String(queues.length)}
            color="amber"
          />
          <StatBlock
            label="Last Sweep Expired"
            value={sweeperStatus?.last ? String(sweeperStatus.last.expired_count) : '—'}
            color="purple"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onSweepOnce} className="border-purple-600 text-purple-300 hover:bg-purple-950">
            <RefreshCw className="w-3 h-3 mr-1" /> Run TTL Sweep Once
          </Button>
          <span className="text-[10px] text-slate-500 font-mono">
            Protocol §10: bundle MUST NOT be re-forwarded after expiry. EXPIRED is terminal.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function StatBlock({ label, value, color }: { label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    emerald: 'border-emerald-500 text-emerald-400',
    amber: 'border-amber-500 text-amber-400',
    purple: 'border-purple-500 text-purple-400',
    slate: 'border-slate-600 text-slate-400',
  };
  return (
    <div className={cn('rounded-lg border bg-slate-950/50 p-3', colorMap[color])}>
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="font-mono text-sm font-semibold mt-1">{value}</div>
    </div>
  );
}

function EmailTranscriptCard({ transcript, smsTranscript, whatsappTranscript }: { transcript: Array<{ message_id: string; to: string; from: string; subject: string; body: string; sent_at: number; bundle_id: string }>; smsTranscript: Array<any>; whatsappTranscript: Array<any> }) {
  const [activeTab, setActiveTab] = useState<'email' | 'sms' | 'whatsapp'>('email');
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Send className="w-4 h-4 text-purple-400" />
          Channel Adapter Transcripts (P6+P8 — EXPERIMENTAL)
        </CardTitle>
        <CardDescription className="text-slate-400">
          The gateway&apos;s adapters package opaque bundle bytes into channel-native messages. Gateway never sees plaintext. Recipient decrypts on the other side.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="mb-3">
            <TabsTrigger value="email">Email ({transcript.length})</TabsTrigger>
            <TabsTrigger value="sms">SMS ({smsTranscript.length})</TabsTrigger>
            <TabsTrigger value="whatsapp">WhatsApp ({whatsappTranscript.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="email">
            {transcript.length === 0 ? (
              <div className="text-sm text-slate-500 italic">No emails sent.</div>
            ) : (
              <ScrollArea className="max-h-[400px] pr-3">
                <div className="space-y-2">
                  {transcript.map((e) => (
                    <div key={e.message_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs text-slate-400">{e.message_id}</span>
                        <Badge variant="outline" className="border-purple-500 text-purple-400 text-[10px]">EMAIL</Badge>
                      </div>
                      <div className="text-xs space-y-0.5 font-mono">
                        <div><span className="text-slate-500">From:</span> <span className="text-slate-300">{e.from}</span></div>
                        <div><span className="text-slate-500">To:</span> <span className="text-slate-300">{e.to}</span></div>
                        <div><span className="text-slate-500">Subject:</span> <span className="text-slate-300">{e.subject}</span></div>
                        <div><span className="text-slate-500">Bundle:</span> <span className="text-slate-300">{e.bundle_id.slice(0, 18)}…</span></div>
                        <div><span className="text-slate-500">Sent at:</span> <span className="text-slate-300">{new Date(e.sent_at).toLocaleTimeString()}</span></div>
                      </div>
                      <details className="mt-2">
                        <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400">Show email body (opaque ciphertext)</summary>
                        <pre className="mt-1 text-[10px] text-slate-500 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{e.body}</pre>
                      </details>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
          <TabsContent value="sms">
            {smsTranscript.length === 0 ? (
              <div className="text-sm text-slate-500 italic">No SMS sent. Switch recipient to SMS (P8) and dispatch.</div>
            ) : (
              <ScrollArea className="max-h-[400px] pr-3">
                <div className="space-y-2">
                  {smsTranscript.map((e: any) => (
                    <div key={e.message_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs text-slate-400">{e.message_id}</span>
                        <Badge variant="outline" className="border-amber-500 text-amber-400 text-[10px]">SMS · {e.segments} seg</Badge>
                      </div>
                      <div className="text-xs space-y-0.5 font-mono">
                        <div><span className="text-slate-500">From:</span> <span className="text-slate-300">{e.from}</span></div>
                        <div><span className="text-slate-500">To:</span> <span className="text-slate-300">{e.to}</span></div>
                        <div><span className="text-slate-500">Bundle:</span> <span className="text-slate-300">{e.bundle_id.slice(0, 18)}…</span></div>
                      </div>
                      <details className="mt-2">
                        <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400">Show SMS body (opaque)</summary>
                        <pre className="mt-1 text-[10px] text-slate-500 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{e.body}</pre>
                      </details>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
          <TabsContent value="whatsapp">
            {whatsappTranscript.length === 0 ? (
              <div className="text-sm text-slate-500 italic">No WhatsApp messages sent. Switch recipient to WhatsApp (P8) and dispatch.</div>
            ) : (
              <ScrollArea className="max-h-[400px] pr-3">
                <div className="space-y-2">
                  {whatsappTranscript.map((e: any) => (
                    <div key={e.message_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs text-slate-400">{e.message_id}</span>
                        <Badge variant="outline" className="border-green-500 text-green-400 text-[10px]">WHATSAPP</Badge>
                      </div>
                      <div className="text-xs space-y-0.5 font-mono">
                        <div><span className="text-slate-500">From:</span> <span className="text-slate-300">{e.from}</span></div>
                        <div><span className="text-slate-500">To:</span> <span className="text-slate-300">{e.to}</span></div>
                        <div><span className="text-slate-500">Bundle:</span> <span className="text-slate-300">{e.bundle_id.slice(0, 18)}…</span></div>
                      </div>
                      <details className="mt-2">
                        <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400">Show WhatsApp body (opaque)</summary>
                        <pre className="mt-1 text-[10px] text-slate-500 font-mono whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{e.body}</pre>
                      </details>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function InboxCard({
  inbox,
  inboxNode,
  setInboxNode,
  nodes,
  onMarkRead,
  aiSummary,
  onAiSummarize,
}: {
  inbox: Array<{ conversation_id: string; messages: Array<any>; unread_count: number }>;
  inboxNode: string;
  setInboxNode: (s: string) => void;
  nodes: NodeDescriptor[];
  onMarkRead: (conversation_id: string) => void;
  aiSummary: { conversation_id: string; summary: string } | null;
  onAiSummarize: (conversation_id: string) => void;
}) {
  const [expandedConv, setExpandedConv] = useState<string | null>(null);

  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Inbox className="w-4 h-4 text-emerald-400" />
          Unified Inbox (P11 — Consumer Application)
        </CardTitle>
        <CardDescription className="text-slate-400">
          Bob&apos;s inbox shows decrypted messages grouped by conversation. Auto-decrypted on delivery using the recipient&apos;s X25519 secret key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Label className="text-xs uppercase tracking-wider text-slate-400">View inbox of</Label>
          <Select value={inboxNode} onValueChange={setInboxNode}>
            <SelectTrigger className="w-48 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {nodes.map((n) => (
                <SelectItem key={n.node_id} value={n.node_id}>{n.display_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {inbox.length === 0 ? (
          <div className="text-sm text-slate-500 italic">
            No messages in {inboxNode}&apos;s inbox yet. Dispatch a bundle to this node above.
          </div>
        ) : (
          <ScrollArea className="max-h-[500px] pr-3">
            <div className="space-y-2">
              {inbox.map((conv) => (
                <div key={conv.conversation_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedConv(expandedConv === conv.conversation_id ? null : conv.conversation_id)}
                  >
                    <div className="flex items-center gap-2">
                      <Mail className="w-3.5 h-3.5 text-cyan-400" />
                      <span className="font-mono text-xs text-slate-300">{conv.conversation_id}</span>
                      {conv.unread_count > 0 && (
                        <Badge variant="outline" className="border-emerald-500 text-emerald-400 text-[10px]">
                          {conv.unread_count} unread
                        </Badge>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500">{conv.messages.length} message(s)</span>
                  </div>

                  {expandedConv === conv.conversation_id && (
                    <div className="mt-3 space-y-2">
                      {conv.messages.map((msg: any, i: number) => (
                        <div key={msg.bundle_id || i} className={cn(
                          'rounded border p-2 text-xs',
                          msg.read ? 'border-slate-800 bg-slate-950/30' : 'border-emerald-700/50 bg-emerald-950/20',
                        )}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-mono text-[10px] text-slate-400">
                              from: {msg.sender.display_name ?? msg.sender.id.slice(0, 12)}…
                            </span>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] text-slate-500">{new Date(msg.received_at).toLocaleTimeString()}</span>
                              <Badge variant="outline" className={cn(
                                'text-[9px]',
                                msg.delivery_state === 'READ' ? 'border-emerald-500 text-emerald-400' : 'border-amber-500 text-amber-400',
                              )}>
                                {msg.delivery_state}
                              </Badge>
                            </div>
                          </div>
                          <p className="text-slate-200 font-mono text-xs">{msg.plaintext}</p>
                        </div>
                      ))}
                      {conv.unread_count > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onMarkRead(conv.conversation_id)}
                          className="border-emerald-600 text-emerald-400 hover:bg-emerald-950 h-7 text-xs"
                        >
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Mark conversation as read
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAiSummarize(conv.conversation_id)}
                        className="border-purple-600 text-purple-300 hover:bg-purple-950 h-7 text-xs"
                      >
                        <Sparkles className="w-3 h-3 mr-1" /> AI Summarize (P14)
                      </Button>
                      {aiSummary && aiSummary.conversation_id === conv.conversation_id && (
                        <div className="rounded border border-purple-800/50 bg-purple-950/20 p-2">
                          <div className="text-[10px] uppercase tracking-wider text-purple-400 mb-1">AI Summary</div>
                          <p className="text-xs text-slate-300">{aiSummary.summary}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {expandedConv !== conv.conversation_id && conv.messages.length > 0 && (
                    <div className="mt-1 text-[10px] text-slate-500 truncate">
                      Last: {conv.messages[conv.messages.length - 1]?.plaintext.slice(0, 60)}…
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

function AnalyticsCard({ analytics }: { analytics: any }) {
  if (!analytics) return null;
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="w-4 h-4 text-cyan-400" />
          Delivery Analytics (P12 — Business Platform)
        </CardTitle>
        <CardDescription className="text-slate-400">
          Aggregate delivery statistics. Per THREAT_MODEL §11: no private message contents — only counts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatBlock label="Dispatched" value={String(analytics.total_dispatched)} color="cyan" />
          <StatBlock label="Delivered" value={String(analytics.total_delivered)} color="emerald" />
          <StatBlock label="Relayed" value={String(analytics.total_relayed)} color="amber" />
          <StatBlock label="Expired" value={String(analytics.total_expired)} color="purple" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatBlock label="No Route" value={String(analytics.total_no_route)} color="slate" />
          <StatBlock label="Queued" value={String(analytics.total_queued)} color="amber" />
          <StatBlock label="Delivery Rate" value={`${(analytics.delivery_rate * 100).toFixed(1)}%`} color="emerald" />
          <StatBlock label="Total Bundles" value={String(analytics.total_dispatched + analytics.total_relayed)} color="cyan" />
        </div>

        {analytics.per_node && analytics.per_node.length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Per-Node Breakdown</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {analytics.per_node.map((pn: any) => (
                <div key={pn.node_id} className="rounded border border-slate-800 bg-slate-950/50 p-2 text-xs font-mono">
                  <div className="flex items-center justify-between">
                    <Badge variant="outline" className="border-slate-700 text-slate-400 text-[9px]">{pn.node_id}</Badge>
                    <span className="text-slate-500">
                      D:{pn.delivered} R:{pn.relayed} E:{pn.expired} NR:{pn.no_route} Q:{pn.queued}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {analytics.route_stats && Object.keys(analytics.route_stats.hop_distribution || {}).length > 0 && (
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Hop Distribution</div>
            <div className="flex gap-2 items-end h-16">
              {Object.entries(analytics.route_stats.hop_distribution).map(([hops, count]) => (
                <div key={hops} className="flex flex-col items-center gap-1">
                  <div className="text-[10px] text-slate-400 font-mono">{String(count)}</div>
                  <div
                    className="w-8 rounded-t bg-cyan-600"
                    style={{ height: `${(Number(count) / Math.max(...Object.values(analytics.route_stats.hop_distribution as Record<string, number>))) * 40}px` }}
                  />
                  <div className="text-[10px] text-slate-500 font-mono">{hops}h</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RoutingPolicyCard({
  policy,
  onUpdate,
}: {
  policy: any;
  onUpdate: (updates: Record<string, any>) => void;
}) {
  if (!policy) return null;
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sliders className="w-4 h-4 text-amber-400" />
          Routing Policy (P12 — Business Governance)
        </CardTitle>
        <CardDescription className="text-slate-400">
          Editable routing policy. Changes affect subsequent dispatches only — existing bundles keep their original policy (immutable per ARCH-003).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Max Hops</Label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10}
                value={policy.max_hops}
                onChange={(e) => onUpdate({ max_hops: parseInt(e.target.value) || 4 })}
                className="w-20 h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <span className="text-[10px] text-slate-500">Max relay hops before NO_ROUTE</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Replication Factor</Label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={10}
                value={policy.replication_factor}
                onChange={(e) => onUpdate({ replication_factor: parseInt(e.target.value) || 1 })}
                className="w-20 h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <span className="text-[10px] text-slate-500">N peers per replicated dispatch</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Require E2E Encryption</Label>
            <div className="flex items-center gap-2">
              <Switch
                checked={policy.require_e2e}
                onCheckedChange={(v) => onUpdate({ require_e2e: v })}
              />
              <span className="text-[10px] text-slate-500">Refuse to send if e2e not possible</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-slate-400">Emergency Only</Label>
            <div className="flex items-center gap-2">
              <Switch
                checked={policy.emergency_only}
                onCheckedChange={(v) => onUpdate({ emergency_only: v })}
              />
              <span className="text-[10px] text-slate-500">Suppress non-emergency traffic</span>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wider text-slate-400">Forbidden Transports (comma-separated)</Label>
          <input
            type="text"
            value={(policy.forbidden_transports || []).join(',')}
            onChange={(e) => onUpdate({ forbidden_transports: e.target.value.split(',').filter((s) => s.trim()) })}
            placeholder="e.g. BLE,LAN"
            className="w-full h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-sm font-mono text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          <p className="text-[10px] text-slate-500">Router will skip these transport types. Example: "BLE" forces LAN-only routing.</p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Active Policy</div>
          <pre className="text-[10px] text-slate-400 font-mono whitespace-pre-wrap">
            {JSON.stringify(policy, null, 2)}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

function DeliveryTimeline({
  delivery,
  queues,
  selectedBundleId,
  onSelect,
  decryptResult,
  onTryDecrypt,
  onMarkRead,
  onViewProofs,
  proofsView,
  toNode,
}: {
  delivery: DeliverySnapshot[];
  queues: QueuedBundle[];
  selectedBundleId: string | null;
  onSelect: (id: string) => void;
  decryptResult: { ok: boolean; plaintext?: string; reason?: string } | null;
  onTryDecrypt: () => void;
  onMarkRead: () => void;
  onViewProofs: () => void;
  proofsView: { bundle_id: string; proofs: Array<{ kind: string; signer_id: string; ts: number; verified: boolean }> } | null;
  toNode: string;
}) {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="w-4 h-4 text-amber-400" />
          Delivery State Machine
        </CardTitle>
        <CardDescription className="text-slate-400">
          <code>sent = true</code> is FORBIDDEN. Delivery is an explicit multi-state machine. Distinguishes &quot;left my device&quot; from &quot;reached the recipient&quot;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {delivery.length === 0 && (
          <div className="text-sm text-slate-500 italic">No bundles dispatched yet. Compose an intent above.</div>
        )}
        <ScrollArea className="max-h-[600px] pr-3">
          <div className="space-y-3">
            {delivery.map((d) => (
              <DeliveryRow
                key={d.bundle_id + d.history[0]?.ts}
                delivery={d}
                selected={selectedBundleId === d.bundle_id}
                onSelect={() => onSelect(d.bundle_id)}
              />
            ))}
          </div>
        </ScrollArea>
        {queues.length > 0 && (
          <div className="rounded-lg border border-amber-700/50 bg-amber-950/30 p-3">
            <div className="flex items-center gap-2 mb-2 text-amber-400 text-xs uppercase tracking-wider">
              <Clock className="w-3.5 h-3.5" />
              DTN Store-and-Forward Queues
            </div>
            <div className="space-y-1">
              {queues.map((q) => (
                <div key={q.node_id + q.bundle_id} className="text-xs font-mono text-slate-300">
                  <Badge variant="outline" className="border-amber-600 text-amber-300 mr-2">{q.node_id}</Badge>
                  bundle {q.bundle_id.slice(0, 14)}… → next: {q.nextHop}
                </div>
              ))}
            </div>
          </div>
        )}
        {selectedBundleId && (
          <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/20 p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-emerald-400">Recipient-side verification</div>
            <div className="text-xs text-slate-400">
              Try to open the selected bundle as <span className="font-mono text-slate-200">{toNode}</span>.
              Only the recipient&apos;s X25519 secret key can decrypt. Relays, gateways, and other nodes cannot.
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={onTryDecrypt} className="border-emerald-600 text-emerald-400 hover:bg-emerald-950">
                Try Decrypt
              </Button>
              <Button size="sm" variant="outline" onClick={onMarkRead} className="border-slate-600 text-slate-200 hover:bg-slate-800">
                Mark READ
              </Button>
              <Button size="sm" variant="outline" onClick={onViewProofs} className="border-purple-600 text-purple-300 hover:bg-purple-950">
                <GitBranch className="w-3 h-3 mr-1" /> View Proof Chain
              </Button>
            </div>
            {decryptResult && (
              <div className={cn('text-xs font-mono rounded p-2', decryptResult.ok ? 'bg-emerald-950/50 text-emerald-200' : 'bg-red-950/50 text-red-300')}>
                {decryptResult.ok ? `✓ ${decryptResult.plaintext}` : `✗ ${decryptResult.reason}`}
              </div>
            )}
            {proofsView && (
              <div className="rounded border border-purple-800/50 bg-purple-950/20 p-2 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-purple-400">
                  Proof Chain · {proofsView.proofs.length} proof(s) for {proofsView.bundle_id.slice(0, 18)}…
                </div>
                {proofsView.proofs.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs font-mono">
                    {p.verified ? (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <XCircle className="w-3 h-3 text-red-400" />
                    )}
                    <Badge variant="outline" className={cn('text-[10px]', p.kind === 'SENDER_SIGNATURE' ? 'border-cyan-500 text-cyan-400' : 'border-purple-500 text-purple-400')}>
                      {p.kind}
                    </Badge>
                    <span className="text-slate-300">signer: {p.signer_id.slice(0, 8)}…</span>
                    <span className="text-slate-500">ts: {new Date(p.ts).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeliveryRow({ delivery, selected, onSelect }: { delivery: DeliverySnapshot; selected: boolean; onSelect: () => void }) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'rounded-lg border bg-slate-950/50 p-3 cursor-pointer transition-colors',
        selected ? 'border-emerald-500 bg-emerald-950/20' : 'border-slate-800 hover:border-slate-700',
      )}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-400">{delivery.bundle_id.slice(0, 14)}…</span>
          {delivery.node_id && (
            <Badge variant="outline" className="text-[9px] border-slate-700 text-slate-400 font-mono">
              <Server className="w-2.5 h-2.5 mr-1" />
              {delivery.node_id}
            </Badge>
          )}
        </div>
        <Badge variant="outline" className={cn('text-[10px] border-slate-700', STATE_COLORS[delivery.current] ?? 'bg-slate-500', 'text-white')}>
          {delivery.current}
        </Badge>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        {delivery.history.map((h, i) => (
          <div key={i} className="flex items-center gap-1 text-[10px]">
            <span className={cn('px-1.5 py-0.5 rounded font-mono text-slate-200', STATE_COLORS[h.to] ?? 'bg-slate-700')}>
              {h.to}
            </span>
            {i < delivery.history.length - 1 && <span className="text-slate-600">→</span>}
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10px] text-slate-500">
        last transition {new Date(delivery.updated_at).toLocaleTimeString()}
      </div>
    </div>
  );
}

function ArchitectureCard() {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          Architecture Invariants
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-slate-300">
        {[
          'Communication is transport-independent',
          'Identity is independent of channel',
          'Bundle is the fundamental routable object',
          'Matrix is one fabric among potentially many',
          'DTN functions without Internet and without Matrix',
          'Routing over capabilities, NOT device types',
          'No fake implementations (no TODO/stub/placeholder)',
          'Architecture tests machine-enforce layer boundaries',
          'No premature complexity',
        ].map((inv) => (
          <div key={inv} className="flex items-start gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
            <span>{inv}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function GovernanceCard() {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="w-4 h-4 text-cyan-400" />
          Architecture Governance
        </CardTitle>
        <CardDescription className="text-slate-400">Authoritative documents</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        {[
          'NORTH_STAR.md',
          'ARCHITECTURE_CONSTITUTION.md',
          'ARCHITECTURE_LEDGER.md',
          'PROTOCOL_SPEC.md',
          'THREAT_MODEL.md',
          'CHANGE_CONTROL.md',
          'ROADMAP.md',
          'ROADMAP.yaml',
        ].map((doc) => (
          <div key={doc} className="font-mono text-slate-400 hover:text-slate-200 cursor-default">
            docs/architecture/{doc}
          </div>
        ))}
        <Separator className="my-3 bg-slate-800" />
        <div className="text-[10px] text-slate-500">
          Changes require an Architecture Change Proposal (ACP-XXXX) accepted through CHANGE_CONTROL.md.
          No foundational change is implemented while PROPOSED.
        </div>
      </CardContent>
    </Card>
  );
}

function RoadmapCard() {
  const phases = [
    { id: 'P0', name: 'Constitutional Foundation', status: 'DONE' },
    { id: 'P1', name: 'Universal Protocol', status: 'DONE' },
    { id: 'P2', name: 'Local Transport', status: 'DONE' },
    { id: 'P3', name: 'DTN', status: 'DONE' },
    { id: 'P4', name: 'Android Edge', status: 'PENDING' },
    { id: 'P5', name: 'Multi-hop Edge', status: 'DONE' },
    { id: 'P6', name: 'Internet Gateway', status: 'DONE' },
    { id: 'P7', name: 'Matrix Fabric', status: 'PENDING' },
    { id: 'P8', name: 'External Channels', status: 'DONE' },
    { id: 'P9', name: 'Intelligent Routing', status: 'DONE' },
    { id: 'P10', name: 'Universal Identity Graph', status: 'DONE' },
    { id: 'P11', name: 'Consumer Application', status: 'DONE' },
    { id: 'P12', name: 'Business Platform', status: 'DONE' },
    { id: 'P13', name: 'Community Network', status: 'PENDING' },
    { id: 'P14', name: 'AI', status: 'DONE' },
  ];
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Radio className="w-4 h-4 text-amber-400" />
          Roadmap
        </CardTitle>
        <CardDescription className="text-slate-400">Build vertically from the protocol outward.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {phases.map((p) => (
          <div key={p.id} className="flex items-center justify-between text-xs py-1">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn('text-[10px] font-mono', p.status === 'DONE' ? 'border-emerald-500 text-emerald-400' : 'border-slate-600 text-slate-400')}>
                {p.id}
              </Badge>
              <span className="text-slate-300">{p.name}</span>
            </div>
            {p.status === 'DONE' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <span className="text-[10px] text-slate-500">pending</span>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ThreatModelCard() {
  return (
    <Card className="bg-slate-900/70 border-slate-800">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="w-4 h-4 text-red-400" />
          Threat Model (invariants)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-slate-300">
        <div className="flex items-start gap-2">
          <Settings2 className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <span>Relays forward opaque encrypted bundles — they CANNOT learn payload contents.</span>
        </div>
        <div className="flex items-start gap-2">
          <Settings2 className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <span>Transport authentication ≠ end-to-end confidentiality.</span>
        </div>
        <div className="flex items-start gap-2">
          <Settings2 className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <span>Capability honesty: self-reported caps are UNVERIFIED until peer-corroborated.</span>
        </div>
        <div className="flex items-start gap-2">
          <Settings2 className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <span>Replay &amp; duplication resistance via bundle_id deduplication.</span>
        </div>
        <div className="flex items-start gap-2">
          <Settings2 className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <span>Sender signatures (Ed25519) over canonical envelope — relay verifies before forwarding.</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Footer({ onReset }: { onReset: () => void }) {
  return (
    <footer className="mt-auto border-t border-slate-800 bg-slate-900/50">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        <div className="text-[10px] text-slate-500 font-mono">
          bundle → transport → destination (no Internet required) · ARCH-001..045 · tested in CI
        </div>
        <Button size="sm" variant="outline" onClick={onReset} className="border-slate-700 text-slate-400 hover:bg-slate-800 text-xs">
          Reset Network
        </Button>
      </div>
    </footer>
  );
}
