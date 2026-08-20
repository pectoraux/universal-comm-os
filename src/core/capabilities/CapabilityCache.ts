/**
 * core/capabilities/CapabilityCache.ts
 *
 * Capability gossip protocol (ROADMAP P5).
 *
 * Per the master prompt:
 *   "P5 — Multi-hop Edge: A → B → C → D where only some nodes have connectivity.
 *    Capability gossip over local transports."
 *
 * Nodes periodically broadcast their NodeCapabilities to direct peers. Each
 * peer caches the advertisement (with TTL) and rebroadcasts it (gossip
 * propagation). The router then has a deep view of the network — not just
 * immediate peers — and can plan multi-hop routes proactively (ARCH-030).
 *
 * This retires the ARCH-027 epidemic-routing fallback when the cache is
 * populated. The fallback remains as a safety net for cold-start.
 *
 * ARCH-029 (added in P5): CapabilityCache is an interface. In-memory impl
 * for tests; Prisma-backed for production (future). Lives in core because
 * it's a protocol-level concern — every node has one.
 *
 * ARCH-031 (added in P5): capability gossip uses a side-channel on the
 * transport (duck-typed `gossip()` method). It does NOT extend the
 * Transport interface (architecture unchanged). Transports that don't
 * implement gossip simply don't propagate.
 */

import type { NodeCapabilities } from './types';

/** A signed (in the demo: unsigned) capability advertisement. */
export interface CapabilityAdvertisement {
  /** The node these capabilities belong to. */
  origin_node_id: string;
  /** The capabilities being advertised. */
  capabilities: NodeCapabilities;
  /** When the advertisement was issued. */
  ts: number;
  /** TTL in ms after which the advertisement is considered stale. */
  ttl_ms: number;
  /**
   * Hop count from the original advertiser. 0 = the advertiser itself.
   * Each rebroadcast increments this. Used to bound propagation and detect loops.
   */
  hop_count: number;
  /** Nodes the advertisement has passed through (for loop detection). */
  path: string[];
}

export interface CapabilityCacheEntry {
  advertisement: CapabilityAdvertisement;
  cached_at: number;
}

export interface CapabilityCache {
  /** Upsert an advertisement. Returns true if the cache was updated. */
  upsert(ad: CapabilityAdvertisement): boolean;
  /** Get the freshest advertisement for a node, or undefined if expired/absent. */
  get(node_id: string): CapabilityAdvertisement | undefined;
  /** List all non-stale advertisements. */
  snapshot(): CapabilityAdvertisement[];
  /** Remove stale entries (TTL elapsed). Returns count removed. */
  prune(now?: number): number;
  /** Clear all entries. */
  clear(): void;
  /** Number of entries (including stale). */
  size(): number;
}

/** Default TTL for capability advertisements: 30 seconds. */
export const DEFAULT_CAPABILITY_TTL_MS = 30_000;

/** Maximum hop count for gossip propagation (prevents infinite loops). */
export const MAX_GOSSIP_HOPS = 6;

export function createCapabilityCache(): CapabilityCache {
  const entries = new Map<string, CapabilityCacheEntry>();

  return {
    upsert(ad) {
      const existing = entries.get(ad.origin_node_id);
      // Only update if the new advertisement is fresher.
      if (existing && existing.advertisement.ts >= ad.ts) return false;
      entries.set(ad.origin_node_id, { advertisement: ad, cached_at: Date.now() });
      return true;
    },

    get(node_id) {
      const entry = entries.get(node_id);
      if (!entry) return undefined;
      const now = Date.now();
      if (now - entry.advertisement.ts > entry.advertisement.ttl_ms) {
        // Stale — treat as absent.
        return undefined;
      }
      return entry.advertisement;
    },

    snapshot() {
      const now = Date.now();
      const out: CapabilityAdvertisement[] = [];
      for (const entry of entries.values()) {
        if (now - entry.advertisement.ts <= entry.advertisement.ttl_ms) {
          out.push(entry.advertisement);
        }
      }
      return out;
    },

    prune(now = Date.now()) {
      let removed = 0;
      for (const [nodeId, entry] of entries.entries()) {
        if (now - entry.advertisement.ts > entry.advertisement.ttl_ms) {
          entries.delete(nodeId);
          removed++;
        }
      }
      return removed;
    },

    clear() {
      entries.clear();
    },

    size() {
      return entries.size;
    },
  };
}

/**
 * Build a CapabilityAdvertisement for the local node.
 *
 * The `ts` is set to the CURRENT time (not the capabilities' advertised_at),
 * so each gossip round produces a fresh ad. This refreshes the TTL on every
 * round, preventing healthy entries from going stale while gossip is active.
 *
 * The capabilities.advertised_at is preserved INSIDE the advertisement for
 * audit/forensics (when the underlying capabilities were last touched).
 */
export function buildAdvertisement(
  capabilities: NodeCapabilities,
  ttl_ms: number = DEFAULT_CAPABILITY_TTL_MS,
): CapabilityAdvertisement {
  return {
    origin_node_id: capabilities.node_id,
    capabilities,
    ts: Date.now(),
    ttl_ms,
    hop_count: 0,
    path: [capabilities.node_id],
  };
}

/**
 * Rebuild an advertisement for rebroadcast: increments hop count, appends
 * the rebroadcasting node to the path. Returns null if hop limit exceeded.
 */
export function rebroadcast(
  ad: CapabilityAdvertisement,
  rebroadcasting_node_id: string,
): CapabilityAdvertisement | null {
  if (ad.hop_count >= MAX_GOSSIP_HOPS) return null;
  if (ad.path.includes(rebroadcasting_node_id)) return null; // loop
  return {
    ...ad,
    hop_count: ad.hop_count + 1,
    path: [...ad.path, rebroadcasting_node_id],
  };
}
