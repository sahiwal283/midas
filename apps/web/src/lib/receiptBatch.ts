/**
 * State for the receipt strip: what the server already has, plus the files
 * still on the wire. Extracted from the component because `apps/web` has no
 * DOM test harness — this is the part worth testing.
 */

import type { Receipt } from '../types';

/** Per-entry cap. The server's own 10 MB per-file limit is not duplicated here. */
export const MAX_RECEIPTS = 10;

export type BatchSlot =
  | { state: 'uploading'; localId: string; name: string; previewUrl: string | null }
  | { state: 'done'; localId: string; receipt: Receipt }
  | { state: 'failed'; localId: string; name: string; file: File; error: string };

/** What one tile renders. */
export type DisplayItem =
  | { kind: 'attached'; receipt: Receipt }
  | { kind: 'slot'; slot: BatchSlot };

/**
 * True for every upload in a batch except the last, which is what the API's
 * `?batch=1` flag means. A lone upload returns false, so the auto-push check
 * still runs exactly as it does today.
 *
 * A retry never goes through this — it is the last upload of its own batch of
 * one, so it must be unbatched and give auto-push a chance to run.
 */
export function isBatchedUpload(index: number, total: number): boolean {
  return index < total - 1;
}

/** Trim a pick down to what still fits, naming whatever was turned away. */
export function acceptFiles(
  picked: File[],
  currentCount: number,
): { accepted: File[]; rejected: string[] } {
  const room = Math.max(0, MAX_RECEIPTS - currentCount);
  return {
    accepted: picked.slice(0, room),
    rejected: picked.slice(room).map((f) => f.name),
  };
}

/**
 * Server receipts in their given order, then any slot the server list has not
 * caught up with. A `done` slot whose receipt is already in the server list is
 * dropped — without that, the tile renders twice for the window between an
 * upload resolving and the receipts query refetching.
 */
export function mergeSlots(serverReceipts: Receipt[], slots: BatchSlot[]): DisplayItem[] {
  const known = new Set(serverReceipts.map((r) => r.id));
  const items: DisplayItem[] = serverReceipts.map((receipt) => ({ kind: 'attached', receipt }));
  for (const slot of slots) {
    if (slot.state === 'done' && known.has(slot.receipt.id)) continue;
    items.push({ kind: 'slot', slot });
  }
  return items;
}
