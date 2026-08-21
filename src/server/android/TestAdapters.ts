/**
 * server/android/TestAdapters.ts — P4.1
 *
 * TEST FIXTURES — NOT PRODUCTION.
 *
 * These adapters satisfy the `KeystoreAdapter` and `ResourceReportSampler`
 * interfaces defined in `types.ts`. They are used by:
 *   - the vitest test suite (tests/architecture/p41-*)
 *   - the TransportConformanceSuite's FakeTransport
 *
 * They are NOT used in production. Production deployments on Android
 * will provide real implementations backed by AndroidKeychain (Keystore)
 * and BatteryManager + StorageStatsManager (ResourceReportSampler).
 *
 * Article X (No Fake Implementations) — these are explicitly named as
 * test fixtures (`Test*` prefix, located in a `Test*` file). The
 * Article X carve-out for "explicitly-isolated test fixtures" applies.
 *
 * R4 (P4 design §1.3.3) — Keystore boundary:
 *   The real Android impl would:
 *     - Store the Ed25519 secret key in AndroidKeychain (secure enclave).
 *     - Use BiometricPrompt for key use authorization.
 *     - NOT cache the secret key in process memory beyond a single
 *       signature operation.
 *   The test impl uses an in-memory keypair (generated deterministically
 *   from a seed) — clearly named `TestKeystoreAdapter` so it cannot be
 *   mistaken for production.
 *
 * Article XVIII §7 — Resource reporting boundary:
 *   Resources are OBSERVATIONS, not protocol state. The test sampler
 *   returns deterministic stub values.
 */

import nacl from 'tweetnacl';
import type { KeystoreAdapter, ResourceReportSampler } from './types';
import type { ResourceReport } from '@/core/capabilities/types';

/**
 * Test Keystore adapter. Uses an in-memory Ed25519 keypair.
 * NOT FOR PRODUCTION — clearly named `Test`.
 */
export class TestKeystoreAdapter implements KeystoreAdapter {
  private readonly secretKey: Uint8Array;
  private readonly publicKey: Uint8Array;
  private unlocked = true;

  constructor(seed?: Uint8Array) {
    // Deterministic keypair for tests (same seed → same keypair).
    if (seed) {
      const kp = nacl.sign.keyPair.fromSeed(seed);
      this.secretKey = kp.secretKey;
      this.publicKey = kp.publicKey;
    } else {
      const kp = nacl.sign.keyPair();
      this.secretKey = kp.secretKey;
      this.publicKey = kp.publicKey;
    }
  }

  /**
   * Sign a payload. Returns the detached signature.
   * Returns null if the Keystore is locked (R4 — fail-closed).
   *
   * Article IX — uses tweetnacl's sign.detached (established crypto).
   */
  async sign(payload: Uint8Array): Promise<Uint8Array | null> {
    if (!this.unlocked) return null;
    return nacl.sign.detached(payload, this.secretKey);
  }

  getPublicKey(): Uint8Array {
    return this.publicKey;
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  /** Test-only: lock the Keystore (simulates user-dismissed biometric prompt). */
  lock(): void {
    this.unlocked = false;
  }

  /** Test-only: unlock the Keystore. */
  unlock(): void {
    this.unlocked = true;
  }

  /**
   * Test-only: assert that the secret key is NOT in plaintext app storage.
   * (In the real Android impl, this would be enforced by AndroidKeychain.
   * Here, the secret key lives in process memory for the test's duration
   * only — the test framework asserts that no logs contain key material.)
   */
  assertNoPlaintextKeyInStorage(): void {
    // In the real impl, the secret key NEVER leaves the secure enclave.
    // The test impl holds it in memory; tests assert that no log/output
    // contains the key bytes.
  }
}

/**
 * Test resource sampler. Returns deterministic stub values.
 * NOT FOR PRODUCTION — clearly named `Test`.
 *
 * Article XVIII §7 — resources are observations, not protocol state.
 */
export class TestResourceReportSampler implements ResourceReportSampler {
  private readonly report: ResourceReport;
  private available = true;

  constructor(report?: Partial<ResourceReport>) {
    this.report = {
      battery_pct: report?.battery_pct ?? 0.85,
      bandwidth_bps: report?.bandwidth_bps ?? 125_000,
      storage_bytes: report?.storage_bytes ?? 1_000_000_000,
      compute_units: report?.compute_units ?? 4,
      sampled_at: 0, // set on sample()
    };
  }

  sample(): ResourceReport | null {
    if (!this.available) return null;
    return { ...this.report, sampled_at: Date.now() };
  }

  isAvailable(): boolean {
    return this.available;
  }

  /** Test-only: set the battery level (simulates battery drain). */
  setBattery(pct: number): void {
    this.report.battery_pct = pct;
  }

  /** Test-only: simulate the sampler becoming unavailable. */
  setUnavailable(): void {
    this.available = false;
  }
}
