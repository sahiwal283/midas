import { describe, expect, it } from 'vitest';
import type { Receipt } from '../types';
import { MAX_RECEIPTS, acceptFiles, isBatchedUpload, mergeSlots, type BatchSlot } from './receiptBatch';

function receipt(id: string, filename = `${id}.jpg`): Receipt {
  return { id, filename } as Receipt;
}

function file(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' });
}

describe('isBatchedUpload', () => {
  it('batches every upload except the last', () => {
    expect(isBatchedUpload(0, 3)).toBe(true);
    expect(isBatchedUpload(1, 3)).toBe(true);
    expect(isBatchedUpload(2, 3)).toBe(false);
  });

  it('does not batch a lone upload, so auto-push still runs as it does today', () => {
    expect(isBatchedUpload(0, 1)).toBe(false);
  });
});

describe('acceptFiles', () => {
  it('accepts everything when well under the cap', () => {
    const { accepted, rejected } = acceptFiles([file('a.jpg'), file('b.jpg')], 0);
    expect(accepted).toHaveLength(2);
    expect(rejected).toEqual([]);
  });

  it('accepts up to the cap and names what it turned away', () => {
    const picked = Array.from({ length: 4 }, (_, i) => file(`p${i}.jpg`));
    const { accepted, rejected } = acceptFiles(picked, MAX_RECEIPTS - 2);
    expect(accepted.map((f) => f.name)).toEqual(['p0.jpg', 'p1.jpg']);
    expect(rejected).toEqual(['p2.jpg', 'p3.jpg']);
  });

  it('accepts nothing once the cap is already reached', () => {
    const { accepted, rejected } = acceptFiles([file('a.jpg')], MAX_RECEIPTS);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual(['a.jpg']);
  });
});

describe('mergeSlots', () => {
  const uploading: BatchSlot = { state: 'uploading', localId: 'L1', name: 'new.jpg', previewUrl: null };
  const failed: BatchSlot = {
    state: 'failed', localId: 'L2', name: 'bad.jpg', file: file('bad.jpg'), error: 'Upload failed',
  };

  it('puts server receipts first, in the order given', () => {
    const items = mergeSlots([receipt('r1'), receipt('r2')], []);
    expect(items).toEqual([
      { kind: 'attached', receipt: receipt('r1') },
      { kind: 'attached', receipt: receipt('r2') },
    ]);
  });

  it('appends unresolved slots after the attached receipts', () => {
    const items = mergeSlots([receipt('r1')], [uploading, failed]);
    expect(items.map((i) => i.kind)).toEqual(['attached', 'slot', 'slot']);
  });

  it('drops a done slot whose receipt is already in the server list', () => {
    // Otherwise the tile renders twice for the moment between the upload
    // resolving and the receipts query refetching.
    const done: BatchSlot = { state: 'done', localId: 'L3', receipt: receipt('r1') };
    const items = mergeSlots([receipt('r1')], [done]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ kind: 'attached', receipt: receipt('r1') });
  });

  it('keeps a done slot the server list has not caught up with yet', () => {
    const done: BatchSlot = { state: 'done', localId: 'L3', receipt: receipt('r9') };
    const items = mergeSlots([receipt('r1')], [done]);
    expect(items).toHaveLength(2);
    expect(items[1]).toEqual({ kind: 'slot', slot: done });
  });
});
