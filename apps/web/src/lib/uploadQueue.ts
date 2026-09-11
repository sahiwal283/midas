/**
 * Client-side "To upload" safety net — see docs/SYNC_AND_OFFLINE.md.
 * Happy path is always live sync to the Midas API; this queue only holds work
 * that could not be delivered (offline / flaky network / transient errors).
 */

const DB_NAME = 'midas-upload-queue';
const DB_VERSION = 2;
const STORE = 'items';

export type UploadQueueStatus = 'pending' | 'syncing' | 'failed';

export interface QueuedFile {
  name: string;
  type: string;
  size: number;
  data: ArrayBuffer;
}

export interface UploadQueueItem {
  id: string;
  clientKey: string;
  createdAt: number;
  updatedAt: number;
  status: UploadQueueStatus;
  retryCount: number;
  lastError?: string;
  payload: {
    merchant: string;
    amount: number;
    date: string;
    currency: string;
    categoryId?: string;
    paymentMethodId?: string;
    description?: string;
  };
  /** Receipt files stored as ArrayBuffers for IndexedDB, in page order. */
  receipts: QueuedFile[];
  /** Indexes of `receipts` already uploaded, so a retry does not duplicate them. */
  uploadedIndexes: number[];
  /** Set after a draft expense was created but receipt upload failed. */
  expenseId?: string;
}

/**
 * v1 stored one `receipt` per item. v2 stores `receipts[]`. A phone may be
 * holding an unsynced expense from v1 right now, so rows are rewritten rather
 * than dropped.
 */
export function migrateQueueItem(raw: unknown): UploadQueueItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<UploadQueueItem> & { receipt?: QueuedFile };

  const receipts = Array.isArray(row.receipts)
    ? row.receipts
    : row.receipt ? [row.receipt] : [];
  if (receipts.length === 0) return null;

  const { receipt: _dropped, ...rest } = row;
  return {
    ...(rest as UploadQueueItem),
    receipts,
    uploadedIndexes: Array.isArray(row.uploadedIndexes) ? row.uploadedIndexes : [],
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
        return;
      }
      // Upgrading from v1: rewrite every row to the v2 shape in place.
      if (event.oldVersion < 2) {
        const tx = req.transaction;
        if (!tx) return;
        const store = tx.objectStore(STORE);
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const migrated = migrateQueueItem(cursor.value);
          if (migrated) {
            cursor.update(migrated);
          } else {
            cursor.delete();
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB tx aborted'));
  });
}

export async function listUploadQueue(): Promise<UploadQueueItem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result as unknown[])
        .map(migrateQueueItem)
        .filter((i): i is UploadQueueItem => i !== null)
        .sort((a, b) => a.createdAt - b.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getUploadQueueCount(): Promise<number> {
  const items = await listUploadQueue();
  return items.filter((i) => i.status !== 'syncing').length;
}

export async function enqueueUpload(input: {
  payload: UploadQueueItem['payload'];
  receipts: File[];
  expenseId?: string;
  lastError?: string;
}): Promise<UploadQueueItem> {
  const receipts: QueuedFile[] = await Promise.all(
    input.receipts.map(async (receipt) => ({
      name: receipt.name,
      type: receipt.type,
      size: receipt.size,
      data: await receipt.arrayBuffer(),
    })),
  );
  const now = Date.now();
  const item: UploadQueueItem = {
    id: crypto.randomUUID(),
    clientKey: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    retryCount: 0,
    lastError: input.lastError,
    payload: input.payload,
    receipts,
    uploadedIndexes: [],
    expenseId: input.expenseId,
  };

  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(item);
  await txDone(tx);
  return item;
}

export async function updateUploadItem(id: string, patch: Partial<UploadQueueItem>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const existing = await new Promise<UploadQueueItem | undefined>((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result as UploadQueueItem | undefined);
    req.onerror = () => reject(req.error);
  });
  if (!existing) return;
  store.put({ ...existing, ...patch, updatedAt: Date.now() });
  await txDone(tx);
}

export async function removeUploadItem(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
}

export function receiptFilesFromQueueItem(item: UploadQueueItem): File[] {
  return item.receipts.map((r) => new File([r.data], r.name, { type: r.type }));
}

export function isLikelyOfflineOrNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; response?: unknown };
  if (e.code === 'ERR_NETWORK' || e.code === 'ECONNABORTED') return true;
  if (!e.response && typeof e.message === 'string' && /network|timeout|failed to fetch/i.test(e.message)) {
    return true;
  }
  return false;
}
