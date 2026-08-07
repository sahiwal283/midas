import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, RefreshCw } from 'lucide-react';
import { getUploadQueueCount } from '../lib/uploadQueue';
import { processUploadQueue } from '../lib/uploadQueueSync';

/** Plain-language replacement for the "upload queue": a tap-to-retry banner. */
export function UploadRetryBanner() {
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState(false);

  const { data: count = 0 } = useQuery({
    queryKey: ['upload-queue-count'],
    queryFn: () => getUploadQueueCount(),
    refetchInterval: 10_000,
  });

  if (count === 0) return null;

  async function retry() {
    setRetrying(true);
    try {
      await processUploadQueue();
    } finally {
      setRetrying(false);
      void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 lg:px-8">
      <p className="flex items-center gap-2 text-sm text-amber-900">
        <CloudUpload className="h-4 w-4 shrink-0" />
        {count} expense{count !== 1 ? 's' : ''} couldn't finish uploading.
      </p>
      <div className="flex shrink-0 items-center gap-3">
        <button
          onClick={() => void retry()}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
          {retrying ? 'Retrying…' : 'Tap to retry'}
        </button>
        <Link to="/to-upload" className="text-xs font-medium text-amber-800 underline">
          Details
        </Link>
      </div>
    </div>
  );
}
