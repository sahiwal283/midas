import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { processUploadQueue } from '../lib/uploadQueueSync';
import { getUploadQueueCount } from '../lib/uploadQueue';

/**
 * Auto-drains the To upload queue when the browser comes back online.
 */
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  useEffect(() => {
    let running = false;

    async function drain() {
      if (running || !navigator.onLine) return;
      const count = await getUploadQueueCount();
      if (count === 0) return;
      running = true;
      try {
        await processUploadQueue();
        void qc.invalidateQueries({ queryKey: ['expenses'] });
        void qc.invalidateQueries({ queryKey: ['upload-queue-count'] });
      } finally {
        running = false;
      }
    }

    const onOnline = () => {
      void drain();
    };
    window.addEventListener('online', onOnline);
    // Attempt once on mount if anything was left from a previous session.
    void drain();
    return () => window.removeEventListener('online', onOnline);
  }, [qc]);

  return <>{children}</>;
}
