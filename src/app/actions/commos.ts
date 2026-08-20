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
