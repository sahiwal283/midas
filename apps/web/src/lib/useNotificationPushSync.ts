import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Refresh the bell and dashboard the moment a push lands. The service worker
 * posts `midas:notification` to every open tab when it shows one; without this
 * the unread badge would lag behind the lock screen until the next poll.
 */
export function useNotificationPushSync(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'midas:notification') return;
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [queryClient]);
}
