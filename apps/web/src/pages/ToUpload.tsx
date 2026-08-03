import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CloudUpload, RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { listUploadQueue, removeUploadItem, type UploadQueueItem } from '../lib/uploadQueue';
import { processUploadQueue } from '../lib/uploadQueueSync';

export function ToUpload() {
  const navigate = useNavigate();
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listUploadQueue());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onOnline = () => {
      void refresh();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [refresh]);

  async function handleSyncAll() {
    setSyncing(true);
    setMessage('');
    try {
      const result = await processUploadQueue();
      setMessage(
        result.total === 0
          ? 'Nothing to upload.'
          : `Uploaded ${result.succeeded} of ${result.total}${result.failed ? ` (${result.failed} failed)` : ''}.`,
      );
      await refresh();
      if (result.succeeded > 0 && result.failed === 0) {
        navigate('/expenses');
      }
    } catch {
      setMessage('Sync failed. Check your connection and try again.');
    } finally {
      setSyncing(false);
    }
  }

  async function handleRemove(id: string) {
    await removeUploadItem(id);
    await refresh();
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">To upload</h1>
          <p className="mt-1 text-sm text-gray-500">
            Expenses saved locally when Midas could not be reached. Upload them when you are back online.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSyncAll()}
          disabled={syncing || items.length === 0 || !navigator.onLine}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Uploading…' : 'Upload all'}
        </button>
      </div>

      {!navigator.onLine && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          You appear offline. Items will stay here until connectivity returns.
        </div>
      )}

      {message && (
        <p className="mt-4 text-sm text-gray-600">{message}</p>
      )}

      <div className="mt-6 space-y-3">
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 px-6 py-12 text-center">
            <CloudUpload className="mx-auto h-8 w-8 text-gray-300" />
            <p className="mt-2 text-sm text-gray-500">No pending uploads. Live sync is working.</p>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-gray-900">{item.payload.merchant}</p>
                <p className="text-sm text-gray-500">
                  ${item.payload.amount.toFixed(2)} · {item.payload.date} · {item.receipt.name}
                </p>
                <p className="mt-1 text-xs text-gray-400">
                  Status: {item.status}
                  {item.retryCount > 0 ? ` · retries ${item.retryCount}` : ''}
                  {item.lastError ? ` · ${item.lastError}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(item.id)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                title="Discard"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
