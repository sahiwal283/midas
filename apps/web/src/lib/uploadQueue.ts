/**
 * Client-side "To upload" safety net — see docs/SYNC_AND_OFFLINE.md.
 * Happy path is always live sync to the Midas API; this queue only holds work
 * that could not be delivered (offline / flaky network / transient errors).
 */

const DB_NAME = 'midas-upload-queue';
const DB_VERSION = 1;
const STORE = 'items';

export type UploadQueueStatus = 'pending' | 'syncing' | 'failed';

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
  /** Receipt file stored as ArrayBuffer for IndexedDB. */
  receipt: {
    name: string;
    type: string;
    size: number;
    data: ArrayBuffer;
  };
  /** Set after a draft expense was created but receipt upload failed. */
  expenseId?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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
      const items = (req.result as UploadQueueItem[]).sort((a, b) => a.createdAt - b.createdAt);
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
  receipt: File;
  expenseId?: string;
  lastError?: string;
}): Promise<UploadQueueItem> {
  const data = await input.receipt.arrayBuffer();
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
    receipt: {
      name: input.receipt.name,
      type: input.receipt.type,
      size: input.receipt.size,
      data,
    },
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

export function receiptFileFromQueueItem(item: UploadQueueItem): File {
  return new File([item.receipt.data], item.receipt.name, { type: item.receipt.type });
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
