import { expenseApi } from '../api/expenses';
import {
  listUploadQueue,
  removeUploadItem,
  updateUploadItem,
  receiptFilesFromQueueItem,
  type UploadQueueItem,
} from './uploadQueue';

export type SyncProgress = {
  total: number;
  succeeded: number;
  failed: number;
};

/**
 * Drain the local To upload queue by calling Midas sync APIs.
 * Reuses expenseId when a draft was already created on a prior partial attempt.
 */
export async function processUploadQueue(
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncProgress> {
  const items = await listUploadQueue();
  const progress: SyncProgress = { total: items.length, succeeded: 0, failed: 0 };

  for (const item of items) {
    await updateUploadItem(item.id, { status: 'syncing' });
    try {
      await syncOne(item);
      await removeUploadItem(item.id);
      progress.succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      await updateUploadItem(item.id, {
        status: 'failed',
        retryCount: item.retryCount + 1,
        lastError: message.slice(0, 500),
      });
      progress.failed += 1;
    }
    onProgress?.({ ...progress });
  }

  return progress;
}

async function syncOne(item: UploadQueueItem): Promise<void> {
  let expenseId = item.expenseId;
  if (!expenseId) {
    const expense = await expenseApi.create({
      merchant: item.payload.merchant,
      amount: item.payload.amount,
      date: item.payload.date,
      currency: item.payload.currency,
      categoryId: item.payload.categoryId,
      paymentMethodId: item.payload.paymentMethodId,
      description: item.payload.description,
    });
    expenseId = expense.id;
    await updateUploadItem(item.id, { expenseId });
  }

  const files = receiptFilesFromQueueItem(item);
  const uploaded = new Set(item.uploadedIndexes);

  for (let i = 0; i < files.length; i += 1) {
    if (uploaded.has(i)) continue;
    // Not the last file: hold the auto-push check so the expense does not reach
    // Zoho with only part of its receipts attached.
    const isLast = i === files.length - 1;
    await expenseApi.uploadReceipt(expenseId, files[i], { batch: !isLast });
    uploaded.add(i);
    await updateUploadItem(item.id, { uploadedIndexes: [...uploaded] });
  }
}
