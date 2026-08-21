/**
 * server/android/types.ts — P4.1
 *
 * Types for the Android Runtime Foundation. These types live in the SERVER
 * layer (Architecture Constitution Article I.7) and MAY import from core/*.
 *
 * The Android Runtime Foundation is governed by Article XVIII (Hardware
 * Boundary Integrity) + ARCH-053 + ARCH-054 (this sprint) + the P4 design
 * doc (§1.3.3 R1-R7 invariants).
 *
 * IMPORTANT: this is a TypeScript implementation of the runtime foundation.
 * The "Android" in the directory name refers to the deployment target
 * (Android devices via React Native + JSI, Node.js Mobile + N-API, or a
 * future Native Kotlin port — see P4 design §1.3.1). The runtime
 * abstraction is platform-independent; the platform-specific glue
 * (BluetoothLeScanner, WifiP2pManager, BatteryManager, AndroidKeyStore)
 * is provided by an implementation of the `KeystoreAdapter` + 
 * `ResourceReportSampler` interfaces defined here.
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
 * This module MUST NOT introduce:
 *   - `AndroidBundle` — the bundle is the canonical CommunicationBundle.
 *   - `AndroidIdentity` — identity is the canonical UniversalIdentity.
 *   - `AndroidDeliveryState` — delivery is the canonical DeliveryTracker.
 *   - `AndroidAuthorization` — authorization is the canonical authorizeNode.
 *   - Substitute cryptographic primitives — all crypto via core/trust/*.
 *
 * Article XVIII §10: transport framing is ephemeral, NOT bundle semantics.
 * Article XVIII §11: gossip is constrained to transport/network observations.
 * Article XVIII §12: RELAY_FORWARD proves forwarding evidence ONLY.
 * Article XVIII §13: StoredBundle contract is ONE protocol contract.
 */

import type { CommunicationBundle } from '@/core/bundle/types';
import type { ResourceReport } from '@/core/capabilities/types';
import type { DeliveryState, DeliveryFailure } from '@/core/delivery/types';

/**
 * P4.1 — Android Runtime Lifecycle (ARCH-054).
 *
 * The lifecycle is owned by the Android host (foreground service in real
 * Android; a TypeScript class in tests / Node.js deployments).
 *
 * Transitions (forward only):
 *   CREATED → INITIALIZING → HYDRATING → RUNNING → DRAINING → STOPPED
 *
 * Rules (P4 design §7):
 *   - The runtime cannot process protocol work before HYDRATING completes.
 *   - Shutdown (DRAINING) prevents new work.
 *   - In-flight work reaches a deterministic terminal/recoverable state.
 *   - Restart produces equivalent protocol state (R1, R3).
 *
 * This lifecycle is NOT a second delivery state machine. It governs the
 * runtime host, not the per-bundle delivery state. Per-bundle delivery
 * state is owned by `DeliveryTracker.transition()` (Article VI).
 */
export type AndroidRuntimeLifecycleState =
  | 'CREATED'
  | 'INITIALIZING'
  | 'HYDRATING'
  | 'RUNNING'
  | 'DRAINING'
  | 'STOPPED';

/**
 * The legal forward transitions. Same semantics as the IdentityLink state
 * machine (ARCH-049) — a pure transition function that throws on illegal
 * transitions. This guarantees the lifecycle is canonical (Article XVIII §1
 * — hardware adapters cannot redefine protocol semantics; the runtime
 * lifecycle is the same kind of canonical state machine).
 */
export const RUNTIME_LIFECYCLE_TRANSITIONS: Record<
  AndroidRuntimeLifecycleState,
  AndroidRuntimeLifecycleState[]
> = {
  CREATED: ['INITIALIZING'],
  INITIALIZING: ['HYDRATING'],
  HYDRATING: ['RUNNING'],
  RUNNING: ['DRAINING'],
  DRAINING: ['STOPPED'],
  STOPPED: [], // terminal
};

export class RuntimeLifecycleError extends Error {
  constructor(
    public readonly fromState: AndroidRuntimeLifecycleState,
    public readonly toState: AndroidRuntimeLifecycleState,
  ) {
    super(
      `Illegal Android runtime lifecycle transition: ${fromState} → ${toState} ` +
      `(ARCH-054 / Article XVIII §1).`,
    );
    this.name = 'RuntimeLifecycleError';
  }
}

export function transitionRuntimeLifecycle(
  from: AndroidRuntimeLifecycleState,
  to: AndroidRuntimeLifecycleState,
): AndroidRuntimeLifecycleState {
  if (!RUNTIME_LIFECYCLE_TRANSITIONS[from].includes(to)) {
    throw new RuntimeLifecycleError(from, to);
  }
  return to;
}

/**
 * Resource observation sampler (ARCH-035 + P4 design §8 + Article XVIII §7).
 *
 * The Android host implements this interface to sample battery, storage,
 * bandwidth, and compute from the platform (BatteryManager,
 * StorageStatsManager, etc.). The TS-side test impl returns deterministic
 * stub values.
 *
 * IMPORTANT: resources are OBSERVATIONS, NOT protocol state (P4 design §13).
 * A resource report does NOT change delivery state, identity state, trust
 * state, or authorization state. It is consumed by the routing layer
 * (ARCH-035 — computeHopMetrics) to make routing decisions.
 */
export interface ResourceReportSampler {
  /** Sample the current resource report. Returns null if sampling fails. */
  sample(): ResourceReport | null;
  /** Whether the sampler is currently available (e.g., BatteryManager ready). */
  isAvailable(): boolean;
}

/**
 * Keystore adapter (ARCH-056 + P4 design §1.3.3 R4 + Article XVIII §4).
 *
 * The Android host implements this interface to access the node's Ed25519
 * signing key from the Android Keystore (secure enclave). The TS-side test
 * impl returns a deterministic in-memory keypair (clearly named as a test
 * fixture, NOT production).
 *
 * Invariants (P4 design §1.3.3 R4):
 *   - The signing secret key MUST NOT be cached in process memory beyond
 *     the duration of a single signature operation.
 *   - The runtime MUST refuse to sign if the Keystore is locked.
 *   - Fail-closed initialization when the Keystore is unavailable.
 *
 * Article IX (Trust model) + ARCH-014 (established cryptography only):
 *   - No new cryptographic primitives.
 *   - All signing via core/trust/Proof.ts → signProof().
 *   - The Keystore holds the Ed25519 secret key; the public key is exported.
 */
export interface KeystoreAdapter {
  /**
   * Sign a payload with the node's Ed25519 signing key.
   * Returns a detached signature (64 bytes).
   *
   * Implementation MUST:
   *   - Use the Android Keystore (`KeyStore.getInstance("AndroidKeyStore")`)
   *     on real Android.
   *   - Prompt for biometric/device authentication if required.
   *   - NOT cache the secret key in process memory.
   *   - Throw (or return null) if the Keystore is locked.
   */
  sign(payload: Uint8Array): Promise<Uint8Array | null>;

  /** The node's Ed25519 public key (exportable; the secret key is not). */
  getPublicKey(): Uint8Array;

  /** Whether the Keystore is currently unlocked and signing is available. */
  isUnlocked(): boolean;
}

/**
 * Persistence recovery snapshot (P4 design §1.3.3 R1, R3 + §5.1 P6).
 *
 * On restart, the runtime queries the persisted state and reconstructs
 * the in-memory cache from this snapshot. The reconstruction is
 * deterministic — given the same snapshot, the runtime produces the
 * same in-memory state.
 */
export interface PersistenceSnapshot {
  /** Bundles in the QUEUED state (waiting for peer reconnect). */
  queuedBundles: Array<{
    bundle: CommunicationBundle;
    nextHop: string;
    queuedAt: number;
  }>;
  /** Bundles already received (for dedup — `ReceivedBundle` table). */
  receivedBundleIds: string[];
  /** Delivery state records (for re-hydrating the in-memory DeliveryTracker). */
  deliveryRecords: Array<{
    bundle_id: string;
    current: DeliveryState | DeliveryFailure;
    history: Array<{ ts: number; from?: string; to: string; node?: string; transport?: string; note?: string }>;
    updated_at: number;
  }>;
}

/**
 * A registered transport (P4 design §12 — Transport Readiness).
 *
 * P4.1 prepares for later transport adapters (BLE, Wi-Fi Direct) by
 * providing a registry against the existing `Transport` interface. P4.1
 * does NOT implement BLE or Wi-Fi Direct — only the registry.
 */
export interface RegisteredTransport {
  readonly transport_id: string;
  readonly transport_type: string;
  /** Register a receive handler. The runtime owns the handler's lifecycle. */
  onReceive(handler: (bundle: CommunicationBundle, from_node_id: string) => void): void;
  /** Graceful shutdown. */
  close?(): Promise<void>;
}

/**
 * Runtime lifecycle observer — used by the test framework to assert that
 * the lifecycle transitions correctly.
 */
export interface RuntimeLifecycleObserver {
  onTransition(
    from: AndroidRuntimeLifecycleState,
    to: AndroidRuntimeLifecycleState,
    ts: number,
  ): void;
}
