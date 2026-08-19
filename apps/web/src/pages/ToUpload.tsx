import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CloudUpload, RefreshCw, Trash2, AlertCircle } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
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
    <div className="page mx-auto max-w-3xl">
      <PageHeader
        title="To upload"
        subtitle="Expenses saved locally when Midas could not be reached. Upload them when you are back online."
        actions={
          <button
            type="button"
            onClick={() => void handleSyncAll()}
            disabled={syncing || items.length === 0 || !navigator.onLine}
            className="btn-primary w-full sm:w-auto"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Uploading…' : 'Upload all'}
          </button>
        }
      />

      {!navigator.onLine && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          You appear offline. Items will stay here until connectivity returns.
        </div>
      )}

      {message && (
        <p className="mt-4 text-sm text-charcoal/70">{message}</p>
      )}

      <div className="mt-6 space-y-3">
        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink/10 px-6 py-12 text-center">
            <CloudUpload className="mx-auto h-8 w-8 text-charcoal/25" />
            <p className="mt-2 text-sm text-muted">No pending uploads. Live sync is working.</p>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-ink/10 bg-white px-4 py-3 sm:items-center sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink">{item.payload.merchant}</p>
                <p className="break-words text-sm text-muted">
                  ${item.payload.amount.toFixed(2)} · {item.payload.date} · {item.receipt.name}
                </p>
                <p className="mt-1 break-words text-xs text-charcoal/40">
                  Status: {item.status}
                  {item.retryCount > 0 ? ` · retries ${item.retryCount}` : ''}
                  {item.lastError ? ` · ${item.lastError}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleRemove(item.id)}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg p-2 text-charcoal/40 hover:bg-brand-50 hover:text-danger"
                title="Discard"
                aria-label="Discard queued upload"
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
