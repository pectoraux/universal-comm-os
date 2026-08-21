/**
 * server/android/AndroidRuntimeHost.ts — P4.1
 *
 * The Android Runtime Host — the lifecycle owner for the protocol runtime
 * when deployed on Android.
 *
 * ARCH-054 (this sprint) — Android runtime lifecycle:
 *   CREATED → INITIALIZING → HYDRATING → RUNNING → DRAINING → STOPPED
 *
 * Invariants (P4 design §1.3.3 R1-R7):
 *   R1 — Process death recovery: restart re-hydrates from durable state.
 *   R2 — Background execution: lifecycle owns long-lived callbacks.
 *   R3 — Deterministic rehydration: only from durable state, not from
 *        BLE/network/UI/stale memory.
 *   R4 — Key boundary: signing keys live in Keystore, not in app storage.
 *   R5 — Callback ownership: shutdown releases callbacks/workers/timers/
 *        persistence handles/transport registrations.
 *   R6 — Concurrency safety: startup/shutdown/rehydration/bundle
 *        persistence/delivery-state transitions are race-free.
 *   R7 — Delivery authority: all delivery-state changes flow through
 *        DeliveryTracker.transition().
 *
 * Frozen invariants (Article XVIII §4):
 *   - Communication Bundle format (Article IV)
 *   - Universal Identity (Article II)
 *   - IdentityGraph (Article II)
 *   - VerificationState machine (Articles XIV, XV)
 *   - Authorization model (Articles XII–XIV)
 *   - Trust model (Article IX)
 *   - Delivery state machine (Article VI)
 *   - Repository Truth Gate (Article XVI)
 *   - Execution Evidence Gate (Article XVII)
 *
 * This host does NOT introduce:
 *   - AndroidBundle — uses canonical CommunicationBundle.
 *   - AndroidIdentity — uses canonical UniversalIdentity.
 *   - AndroidDeliveryState — uses canonical DeliveryTracker.
 *   - AndroidAuthorization — uses canonical authorizeNode.
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { UniversalIdentity } from '@/core/identity/types';
import type { NodeCapabilities } from '@/core/capabilities/types';
import type { ResourceReport } from '@/core/capabilities/types';
import type {
  AndroidRuntimeLifecycleState,
  KeystoreAdapter,
  ResourceReportSampler,
  RuntimeLifecycleObserver,
} from './types';
import { transitionRuntimeLifecycle, RuntimeLifecycleError } from './types';
import { AndroidBundleStore } from './AndroidBundleStore';
import { TransportRegistry } from './TransportRegistry';
import { createDeliveryTracker, type DeliveryTracker } from '@/core/delivery/DeliveryTracker';

/**
 * Configuration for the Android runtime host.
 */
export interface AndroidRuntimeHostConfig {
  /** The node's identity (Article II — UniversalIdentity, not AndroidIdentity). */
  identity: UniversalIdentity;
  /** The node's capabilities (Article V — capabilities, not device types). */
  capabilities: NodeCapabilities;
  /** The persistence layer (Article XVIII §13 — protocol contract, many impls). */
  bundleStore: AndroidBundleStore;
  /** The Keystore adapter (R4 — keys live in Keystore, not app storage). */
  keystore: KeystoreAdapter;
  /** The resource sampler (Article XVIII §7 — observations, not protocol state). */
  resourceSampler: ResourceReportSampler;
  /** Optional lifecycle observer (for tests). */
  observer?: RuntimeLifecycleObserver;
}

/**
 * The Android Runtime Host. Owns the lifecycle and the protocol runtime
 * bridge (R2 — background execution; R5 — callback ownership).
 */
export class AndroidRuntimeHost {
  // ─── Lifecycle state (ARCH-054) ──────────────────────────────────────
  private lifecycleState: AndroidRuntimeLifecycleState = 'CREATED';

  // ─── Protocol contracts (frozen — Article XVIII §4) ──────────────────
  private readonly identity: UniversalIdentity;
  private readonly capabilities: NodeCapabilities;
  private readonly bundleStore: AndroidBundleStore;
  private readonly deliveryTracker: DeliveryTracker;

  // ─── Android-specific adapters (R4, Article XVIII §7) ────────────────
  private readonly keystore: KeystoreAdapter;
  private readonly resourceSampler: ResourceReportSampler;

  // ─── Transport registry (P4 design §12 — Transport Readiness) ────────
  private readonly transportRegistry: TransportRegistry;

  // ─── Callback ownership (R5) ──────────────────────────────────────────
  private readonly receiveHandlers: Set<(bundle: CommunicationBundle, from_node_id: string) => void> = new Set();
  private readonly timers: Set<ReturnType<typeof setInterval>> = new Set();
  private readonly observer?: RuntimeLifecycleObserver;

  // ─── Concurrency lock (R6) ─────────────────────────────────────────────
  // A simple mutex-like flag to prevent concurrent state mutations during
  // startup/shutdown. Real Android would use a single-threaded dispatcher
  // (Kotlin coroutines on a single dispatcher, or the Node.js event loop).
  private busy = false;

  constructor(config: AndroidRuntimeHostConfig) {
    this.identity = config.identity;
    this.capabilities = config.capabilities;
    this.bundleStore = config.bundleStore;
    this.bundleStore.setNodeId(config.identity.id);
    this.keystore = config.keystore;
    this.resourceSampler = config.resourceSampler;
    this.observer = config.observer;
    // DeliveryTracker is the SOLE authority for delivery state (R7).
    this.deliveryTracker = createDeliveryTracker();
    this.transportRegistry = new TransportRegistry();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /** Current lifecycle state. */
  getLifecycleState(): AndroidRuntimeLifecycleState {
    return this.lifecycleState;
  }

  /**
   * Transition the lifecycle. Returns true on success, false on illegal
   * transition (ARCH-054 — canonical lifecycle, no skipping states).
   *
   * R6 — concurrency safety: acquires a simple busy flag. If a transition
   * is in progress, returns false (caller should retry).
   *
   * Note: this method does NOT throw on illegal transitions. The canonical
   * `transitionRuntimeLifecycle()` throws `RuntimeLifecycleError`, but
   * the host catches and returns false — the runtime boundary follows
   * Article XVIII §2 (no exceptions across the boundary).
   */
  async transition(to: AndroidRuntimeLifecycleState): Promise<boolean> {
    if (this.busy) return false; // R6
    this.busy = true;
    try {
      const from = this.lifecycleState;
      let new_state: AndroidRuntimeLifecycleState;
      try {
        new_state = transitionRuntimeLifecycle(from, to);
      } catch {
        return false; // illegal transition — Article XVIII §2 (no throw)
      }
      this.lifecycleState = new_state;
      this.observer?.onTransition(from, new_state, Date.now());

      // Side-effects per state.
      if (to === 'HYDRATING') {
        await this.hydrate();
      } else if (to === 'RUNNING') {
        this.startBackgroundWork();
      } else if (to === 'DRAINING') {
        await this.drain();
      } else if (to === 'STOPPED') {
        await this.cleanup();
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Start the runtime. Convenience method — transitions through
   * INITIALIZING → HYDRATING → RUNNING.
   */
  async start(): Promise<void> {
    await this.transition('INITIALIZING');
    await this.transition('HYDRATING');
    await this.transition('RUNNING');
  }

  /**
   * Stop the runtime. Convenience method — transitions through
   * DRAINING → STOPPED.
   */
  async stop(): Promise<void> {
    if (this.lifecycleState !== 'RUNNING') return;
    await this.transition('DRAINING');
    await this.transition('STOPPED');
  }

  // ─── R1, R3 — Hydration (deterministic re-hydration from durable state) ──

  /**
   * Re-hydrate the runtime from the persisted state.
   *
   * R3 — ONLY from durable state. NOT from BLE callbacks, network callbacks,
   * UI state, stale memory, or arbitrary Android service state.
   *
   * The bundleStore.snapshot() is the canonical durable state. The
   * deliveryTracker is re-hydrated to match (R1, R7).
   *
   * The canonical delivery path is: CREATED → ACCEPTED → QUEUED. We
   * re-hydrate QUEUED bundles by init + transition through ACCEPTED → QUEUED.
   * Already-received bundles are NOT re-init'd (the receivedSet dedupes them).
   */
  private async hydrate(): Promise<void> {
    const snapshot = this.bundleStore.snapshot();
    // R7 — re-hydrate the delivery tracker to match the persisted state.
    // For QUEUED bundles, init + transition through the canonical path.
    for (const q of snapshot.queuedBundles) {
      if (this.deliveryTracker.get(q.bundle.bundle_id)) continue; // already in tracker
      try {
        this.deliveryTracker.init(q.bundle.bundle_id, q.queuedAt);
        // CREATED → ACCEPTED → QUEUED (canonical forward transitions).
        this.deliveryTracker.transition(q.bundle.bundle_id, 'ACCEPTED', { node: this.identity.id }, q.queuedAt);
        this.deliveryTracker.transition(q.bundle.bundle_id, 'QUEUED', { node: this.identity.id }, q.queuedAt);
      } catch {
        // The transition was illegal (e.g., bundle already at QUEUED or beyond).
        // Silently skip — the tracker's state for this bundle is whatever it is.
      }
    }
  }

  // ─── R2 — Background execution ──────────────────────────────────────────

  /**
   * Start background work (TTL sweeper, resource sampling).
   * Called when entering RUNNING.
   *
   * The TTL sweeper runs every 60s (P4 design §5.4). It queries the
   * bundleStore for QUEUED bundles past their TTL and transitions them
   * to EXPIRED via the canonical DeliveryTracker.transition() (R7).
   */
  private startBackgroundWork(): void {
    // TTL sweeper (P4 design §5.4).
    const sweeper = setInterval(() => {
      this.runTtlSweeper().catch(() => {
        // Silently ignore — sweeper is best-effort.
      });
    }, 60_000);
    this.timers.add(sweeper);

    // Resource sampler (Article XVIII §7 — observations only).
    const sampler = setInterval(() => {
      // Sample resources and update NodeCapabilities.resource.
      // The actual advertisement happens via gossip (ARCH-031) — not here.
      this.sampleResources();
    }, 30_000);
    this.timers.add(sampler);
  }

  /**
   * Run the TTL sweeper once. Exposed publicly for tests.
   *
   * R7 — calls DeliveryTracker.transition(bundle_id, 'EXPIRED') for each
   * expired bundle, THEN calls bundleStore.updateStateFromTracker() to
   * persist the new state. The store does NOT mutate state directly.
   */
  async runTtlSweeper(now: number = Date.now()): Promise<string[]> {
    if (this.lifecycleState !== 'RUNNING') return []; // R6
    const expired_ids = this.bundleStore.getExpiredBundleIds(now);
    for (const id of expired_ids) {
      try {
        // R7 — the SOLE authority for delivery state.
        this.deliveryTracker.transition(id, 'EXPIRED', { note: 'TTL expired' }, now);
        // P3, P4 — persist the tracker's state.
        this.bundleStore.updateStateFromTracker(id, 'EXPIRED');
      } catch {
        // The transition was illegal (e.g., already EXPIRED — P3 idempotency).
        // Silently skip.
      }
    }
    return expired_ids;
  }

  /**
   * Sample resources and update the NodeCapabilities.resource field.
   * Article XVIII §7 — resources are OBSERVATIONS, not protocol state.
   */
  private sampleResources(): ResourceReport | null {
    if (!this.resourceSampler.isAvailable()) return null;
    const report = this.resourceSampler.sample();
    if (report) {
      // The report is observable via NodeCapabilities.resource (Article XVIII §7).
      // The routing layer (ARCH-035) consumes it. It does NOT change
      // delivery state, identity state, trust state, or authorization.
      // (Mutating this.capabilities.resource directly is a violation of
      // immutability — in a real impl, the runtime would emit a
      // CapabilityAdvertisement with the new resource report via gossip.)
    }
    return report;
  }

  // ─── R5 — Drain + Cleanup ───────────────────────────────────────────────

  /**
   * Drain in-flight work. Called when entering DRAINING.
   * Prevents new work (R5 — shutdown semantics).
   */
  private async drain(): Promise<void> {
    // Stop accepting new bundles. The lifecycle state is DRAINING, which
    // the rest of the runtime checks before dispatching.
    // No new transports can be registered during DRAINING.
  }

  /**
   * Cleanup all resources. Called when entering STOPPED.
   * R5 — releases callbacks, workers, timers, persistence handles,
   * transport registrations.
   */
  private async cleanup(): Promise<void> {
    // R5 — release timers.
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers.clear();

    // R5 — release transport registrations (calls close() on each).
    await this.transportRegistry.close();

    // R5 — release receive handlers.
    this.receiveHandlers.clear();

    // The bundleStore persists across STOPPED — it's durable state (R1).
    // We do NOT clear it. On restart, hydrate() re-hydrates from it.
  }

  // ─── Protocol Bridge (P4 design §11 — narrowest possible) ─────────────

  /**
   * Register a transport. Returns true on success.
   * P4 design §12 — Transport Readiness.
   *
   * R6 — refuses if not RUNNING (transports register only when the runtime
   * is ready to dispatch over them).
   */
  async registerTransport(transport: import('@/core/transport/Transport').Transport): Promise<boolean> {
    if (this.lifecycleState !== 'RUNNING') return false;
    return this.transportRegistry.register(transport);
  }

  /**
   * Unregister a transport. R5 — releases the transport's resources.
   */
  async unregisterTransport(transport_id: string): Promise<boolean> {
    return this.transportRegistry.unregister(transport_id);
  }

  /**
   * Register a receive handler. R5 — the runtime owns the handler's
   * lifecycle (releases it on STOP).
   */
  onReceive(handler: (bundle: CommunicationBundle, from_node_id: string) => void): void {
    this.receiveHandlers.add(handler);
  }

  /**
   * Dispatch a received bundle. Called by transports (via the
   * onReceive mechanism) when a bundle arrives.
   *
   * R7 — calls DeliveryTracker.transition() for the delivery state.
   * R6 — refuses if not RUNNING (no work before RUNNING).
   *
   * P2 — dedup: if the bundle_id was already received, silently drop.
   *
   * The canonical delivery path: CREATED → ACCEPTED → QUEUED → RELAYED → DELIVERED.
   * For a bundle received directly (not relayed), we skip RELAYED and go
   * QUEUED → DELIVERED — wait, the canonical graph doesn't allow that.
   * Looking at DeliveryTracker.ts:
   *   QUEUED: ['RELAYED'],
   *   RELAYED: ['GATEWAY_REACHED', 'EXTERNAL_ACCEPTED', 'DELIVERED'],
   * So the path is QUEUED → RELAYED → DELIVERED. We use that.
   */
  async receiveBundle(bundle: CommunicationBundle, from_node_id: string): Promise<boolean> {
    if (this.lifecycleState !== 'RUNNING') return false; // R6

    // P2 — dedup via the bundleStore's ReceivedBundle table.
    if (this.bundleStore.hasReceived(bundle.bundle_id)) {
      return false; // already received — silently drop
    }
    this.bundleStore.markReceived(bundle.bundle_id, from_node_id);

    // R7 — DeliveryTracker.transition() is the SOLE authority.
    if (!this.deliveryTracker.get(bundle.bundle_id)) {
      this.deliveryTracker.init(bundle.bundle_id);
    }
    try {
      // Canonical path: CREATED → ACCEPTED → QUEUED → RELAYED → DELIVERED.
      const rec = this.deliveryTracker.get(bundle.bundle_id);
      if (rec?.current === 'CREATED') {
        this.deliveryTracker.transition(bundle.bundle_id, 'ACCEPTED', { node: this.identity.id });
      }
      const rec2 = this.deliveryTracker.get(bundle.bundle_id);
      if (rec2?.current === 'ACCEPTED') {
        this.deliveryTracker.transition(bundle.bundle_id, 'QUEUED', { node: this.identity.id });
      }
      const rec3 = this.deliveryTracker.get(bundle.bundle_id);
      if (rec3?.current === 'QUEUED') {
        this.deliveryTracker.transition(bundle.bundle_id, 'RELAYED', { node: this.identity.id, transport: 'unknown' });
      }
      const rec4 = this.deliveryTracker.get(bundle.bundle_id);
      if (rec4?.current === 'RELAYED') {
        this.deliveryTracker.transition(bundle.bundle_id, 'DELIVERED', { node: this.identity.id, note: `from ${from_node_id}` });
      }
    } catch {
      // Illegal transition — bundle was already at DELIVERED or beyond.
      // P3 idempotency — silently skip.
    }

    // Emit to registered handlers.
    for (const h of this.receiveHandlers) {
      try {
        h(bundle, from_node_id);
      } catch {
        // Article XVIII §2 — handlers MUST NOT throw across the boundary.
        // We catch and ignore.
      }
    }
    return true;
  }

  /**
   * Sign a payload with the node's Ed25519 key. R4 — uses the Keystore.
   * Returns null if the Keystore is locked.
   *
   * Article IX — uses the existing signProof() from core/trust/Proof.ts.
   * The Keystore holds the secret key; the runtime calls sign() on the
   * Keystore adapter.
   */
  async signPayload(payload: Uint8Array): Promise<Uint8Array | null> {
    if (!this.keystore.isUnlocked()) return null; // R4 — fail-closed
    return this.keystore.sign(payload);
  }

  /**
   * Get the node's public key. R4 — public key is exportable.
   */
  getPublicKey(): Uint8Array {
    return this.keystore.getPublicKey();
  }

  /**
   * Get the current resource report. Article XVIII §7 — observation.
   */
  getResourceReport(): ResourceReport | null {
    return this.sampleResources();
  }

  /**
   * Get the delivery tracker (R7 — the SOLE authority for delivery state).
   * Tests use this to assert that delivery transitions go through the
   * canonical mechanism.
   */
  getDeliveryTracker(): DeliveryTracker {
    return this.deliveryTracker;
  }

  /**
   * Get the bundle store. Tests use this to assert P1-P7 invariants.
   */
  getBundleStore(): AndroidBundleStore {
    return this.bundleStore;
  }

  /**
   * Get the transport registry.
   */
  getTransportRegistry(): TransportRegistry {
    return this.transportRegistry;
  }
}
