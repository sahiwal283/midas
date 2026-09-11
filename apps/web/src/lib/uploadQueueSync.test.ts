import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { UploadQueueItem, QueuedFile } from './uploadQueue';

// Pure-logic tests only: apps/web has no DOM harness, so `expenseApi` and the
// IndexedDB-backed queue module are both mocked. `File` objects never appear —
// `receiptFilesFromQueueItem` is mocked to hand back plain marker objects,
// which is all `syncOne`'s resume logic actually cares about (identity and
// position, not real file contents).
vi.mock('../api/expenses', () => ({
  expenseApi: {
    create: vi.fn(),
    uploadReceipt: vi.fn(),
  },
}));

vi.mock('./uploadQueue', async () => ({
  listUploadQueue: vi.fn(),
  removeUploadItem: vi.fn(),
  updateUploadItem: vi.fn(),
  receiptFilesFromQueueItem: vi.fn(),
}));

import { expenseApi } from '../api/expenses';
import { listUploadQueue, removeUploadItem, updateUploadItem, receiptFilesFromQueueItem } from './uploadQueue';
import { processUploadQueue } from './uploadQueueSync';

const create = vi.mocked(expenseApi.create);
const uploadReceipt = vi.mocked(expenseApi.uploadReceipt);
const listQueue = vi.mocked(listUploadQueue);
const removeItem = vi.mocked(removeUploadItem);
const updateItem = vi.mocked(updateUploadItem);
const filesFromItem = vi.mocked(receiptFilesFromQueueItem);

const payload = { merchant: 'Acme', amount: 12.5, date: '2026-09-11', currency: 'USD' };

/** A marker object standing in for a real `File` — only identity matters here. */
function marker(name: string) {
  return { name } as unknown as File;
}

function item(overrides: Partial<UploadQueueItem> = {}): UploadQueueItem {
  return {
    id: 'q1',
    clientKey: 'k1',
    createdAt: 1,
    updatedAt: 1,
    status: 'pending',
    retryCount: 0,
    payload,
    receipts: [] as QueuedFile[],
    uploadedIndexes: [],
    expenseId: 'e1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateItem.mockResolvedValue(undefined);
  removeItem.mockResolvedValue(undefined);
});

describe('processUploadQueue — syncOne resume behavior', () => {
  it('skips already-uploaded indexes rather than re-uploading them', async () => {
    const files = [marker('r0'), marker('r1'), marker('r2')];
    filesFromItem.mockReturnValue(files);
    listQueue.mockResolvedValue([item({ uploadedIndexes: [0] })]);
    uploadReceipt.mockResolvedValue({ id: 'rcpt' } as never);

    await processUploadQueue();

    const uploadedFiles = uploadReceipt.mock.calls.map((c) => c[1]);
    expect(uploadedFiles).toEqual([files[1], files[2]]);
    expect(create).not.toHaveBeenCalled();
  });

  it('sends batch:true for every file except the last', async () => {
    const files = [marker('r0'), marker('r1'), marker('r2')];
    filesFromItem.mockReturnValue(files);
    listQueue.mockResolvedValue([item({ uploadedIndexes: [] })]);
    uploadReceipt.mockResolvedValue({ id: 'rcpt' } as never);

    await processUploadQueue();

    expect(uploadReceipt).toHaveBeenNthCalledWith(1, 'e1', files[0], { batch: true });
    expect(uploadReceipt).toHaveBeenNthCalledWith(2, 'e1', files[1], { batch: true });
    expect(uploadReceipt).toHaveBeenNthCalledWith(3, 'e1', files[2], { batch: false });
  });

  it('a single-file item is unbatched', async () => {
    const files = [marker('only')];
    filesFromItem.mockReturnValue(files);
    listQueue.mockResolvedValue([item({ uploadedIndexes: [] })]);
    uploadReceipt.mockResolvedValue({ id: 'rcpt' } as never);

    await processUploadQueue();

    expect(uploadReceipt).toHaveBeenCalledTimes(1);
    expect(uploadReceipt).toHaveBeenCalledWith('e1', files[0], { batch: false });
  });

  it('persists uploadedIndexes after each success, so a retry resumes past what already landed', async () => {
    const files = [marker('r0'), marker('r1'), marker('r2')];
    filesFromItem.mockReturnValue(files);
    listQueue.mockResolvedValue([item({ uploadedIndexes: [] })]);
    uploadReceipt.mockResolvedValue({ id: 'rcpt' } as never);

    await processUploadQueue();

    const indexSnapshots = updateItem.mock.calls
      .map((c) => c[1])
      .filter((patch): patch is { uploadedIndexes: number[] } => 'uploadedIndexes' in patch)
      .map((patch) => patch.uploadedIndexes);
    // Persisted incrementally — after file 0, after file 1, after file 2 — not
    // just once at the very end, so a mid-batch failure still resumes correctly.
    expect(indexSnapshots).toEqual([[0], [0, 1], [0, 1, 2]]);
  });

  it('resumes from the persisted index instead of re-uploading when an earlier file already failed and was retried', async () => {
    const files = [marker('r0'), marker('r1')];
    filesFromItem.mockReturnValue(files);
    // Simulates a prior partial attempt: file 0 already landed and was
    // persisted; only file 1 remains.
    listQueue.mockResolvedValue([item({ uploadedIndexes: [0] })]);
    uploadReceipt.mockResolvedValue({ id: 'rcpt' } as never);

    await processUploadQueue();

    expect(uploadReceipt).toHaveBeenCalledTimes(1);
    expect(uploadReceipt).toHaveBeenCalledWith('e1', files[1], { batch: false });
    expect(removeItem).toHaveBeenCalledWith('q1');
  });

  it('a failure partway through still leaves the earlier success persisted, and marks the item failed rather than removing it', async () => {
    const files = [marker('r0'), marker('r1')];
    filesFromItem.mockReturnValue(files);
    listQueue.mockResolvedValue([item({ uploadedIndexes: [] })]);
    uploadReceipt
      .mockResolvedValueOnce({ id: 'rcpt0' } as never)
      .mockRejectedValueOnce(new Error('network down'));

    const progress = await processUploadQueue();

    expect(progress).toEqual({ total: 1, succeeded: 0, failed: 1 });
    expect(removeItem).not.toHaveBeenCalled();
    const indexSnapshots = updateItem.mock.calls
      .map((c) => c[1])
      .filter((patch): patch is { uploadedIndexes: number[] } => 'uploadedIndexes' in patch)
      .map((patch) => patch.uploadedIndexes);
    expect(indexSnapshots).toEqual([[0]]);
    const failurePatch = updateItem.mock.calls.find((c) => 'status' in c[1] && c[1].status === 'failed');
    expect(failurePatch?.[1]).toMatchObject({ status: 'failed', retryCount: 1 });
  });
});
