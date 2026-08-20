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

  const [fromNode, setFromNode] = useState('alice');
  const [toNode, setToNode] = useState('bob');
  const [intentType, setIntentType] = useState<'SEND_MESSAGE' | 'NOTIFY' | 'REQUEST_RESPONSE' | 'DELIVER_DOCUMENT' | 'SEND_MEDIA' | 'EMERGENCY_ALERT' | 'SYNC_CONVERSATION'>('SEND_MESSAGE');
  const [priority, setPriority] = useState<'BULK' | 'NORMAL' | 'PRIORITY' | 'URGENT' | 'EMERGENCY'>('NORMAL');
  const [plaintext, setPlaintext] = useState('Hello from offline-first fabric — encrypted end-to-end, relayed without Internet.');

  const refresh = useCallback(async () => {
    const [n, ns, dl, q] = await Promise.all([
      getNetworkStateAction(),
      listNodesAction(),
      getDeliverySnapshotsAction(),
      getQueuedBundlesAction(),
    ]);
    // Defer state updates out of the effect-render cycle to avoid cascading renders.
    setTimeout(() => {
      setNetwork(n);
      setNodes(ns as NodeDescriptor[]);
      setDelivery(dl);
      setQueues(q);
    }, 0);
  }, []);

  useEffect(() => {
    // Initial load (NOT setState in effect body — wrapped in setTimeout via refresh).
    const id = setInterval(refresh, 1500);
    void refresh();
    return () => clearInterval(id);
  }, [refresh]);

  const onDispatch = useCallback(async () => {
    if (fromNode === toNode) {
      toast({ title: 'Sender and recipient are the same', variant: 'destructive' });
      return;
    }
    const res = await dispatchBundleAction({
      from_node_id: fromNode,
      to_node_id: toNode,
      plaintext,
      intent_type: intentType,
      priority,
    });
    setLastDispatch(res);
    if (res.status === 'DISPATCHED' || res.status === 'QUEUED') {
      toast({
        title: `Bundle ${res.status.toLowerCase()}`,
        description: res.route_plan
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
  }, [fromNode, toNode, plaintext, intentType, priority, toast, refresh]);

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

  const onReset = useCallback(async () => {
    await resetNetworkAction();
    setSelectedBundleId(null);
    setLastDispatch(null);
    setDecryptResult(null);
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
            intentType={intentType}
            setIntentType={setIntentType}
            priority={priority}
            setPriority={setPriority}
            plaintext={plaintext}
            setPlaintext={setPlaintext}
            nodes={nodes}
            onDispatch={onDispatch}
            lastDispatch={lastDispatch}
          />
          <NetworkTopology network={network} nodes={nodes} />
          <DeliveryTimeline
            delivery={delivery}
            queues={queues}
            selectedBundleId={selectedBundleId}
            onSelect={setSelectedBundleId}
            decryptResult={decryptResult}
            onTryDecrypt={onTryDecrypt}
            onMarkRead={onMarkRead}
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
          P0 · P1 · P2 live
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
  intentType: string;
  setIntentType: (s: any) => void;
  priority: string;
  setPriority: (s: any) => void;
  plaintext: string;
  setPlaintext: (s: string) => void;
  nodes: NodeDescriptor[];
  onDispatch: () => void;
  lastDispatch: DispatchResponse | null;
}) {
  const {
    fromNode,
    setFromNode,
    toNode,
    setToNode,
    intentType,
    setIntentType,
    priority,
    setPriority,
    plaintext,
    setPlaintext,
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
            <Label htmlFor="to" className="text-xs uppercase tracking-wider text-slate-400">Recipient</Label>
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

        <div className="flex items-center gap-2">
          <Button onClick={onDispatch} className="bg-emerald-600 hover:bg-emerald-500">
            <Send className="w-4 h-4 mr-2" /> Dispatch Bundle
          </Button>
          <span className="text-xs text-slate-400">
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

function DeliveryTimeline({
  delivery,
  queues,
  selectedBundleId,
  onSelect,
  decryptResult,
  onTryDecrypt,
  onMarkRead,
  toNode,
}: {
  delivery: DeliverySnapshot[];
  queues: QueuedBundle[];
  selectedBundleId: string | null;
  onSelect: (id: string) => void;
  decryptResult: { ok: boolean; plaintext?: string; reason?: string } | null;
  onTryDecrypt: () => void;
  onMarkRead: () => void;
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
            </div>
            {decryptResult && (
              <div className={cn('text-xs font-mono rounded p-2', decryptResult.ok ? 'bg-emerald-950/50 text-emerald-200' : 'bg-red-950/50 text-red-300')}>
                {decryptResult.ok ? `✓ ${decryptResult.plaintext}` : `✗ ${decryptResult.reason}`}
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
        <div className="font-mono text-xs text-slate-400">{delivery.bundle_id.slice(0, 18)}…</div>
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
    { id: 'P3', name: 'DTN', status: 'PENDING' },
    { id: 'P4', name: 'Android Edge', status: 'PENDING' },
    { id: 'P5', name: 'Multi-hop Edge', status: 'PENDING' },
    { id: 'P6', name: 'Internet Gateway', status: 'PENDING' },
    { id: 'P7', name: 'Matrix Fabric', status: 'PENDING' },
    { id: 'P8', name: 'External Channels', status: 'PENDING' },
    { id: 'P9', name: 'Intelligent Routing', status: 'PENDING' },
    { id: 'P10', name: 'Universal Identity Graph', status: 'PENDING' },
    { id: 'P11', name: 'Consumer Application', status: 'PENDING' },
    { id: 'P12', name: 'Business Platform', status: 'PENDING' },
    { id: 'P13', name: 'Community Network', status: 'PENDING' },
    { id: 'P14', name: 'AI', status: 'PENDING' },
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
          bundle → transport → destination (no Internet required) · ARCH-001..020 · tested in CI
        </div>
        <Button size="sm" variant="outline" onClick={onReset} className="border-slate-700 text-slate-400 hover:bg-slate-800 text-xs">
          Reset Network
        </Button>
      </div>
    </footer>
  );
}
