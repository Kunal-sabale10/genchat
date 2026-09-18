import { useState, useEffect, useCallback } from 'react';

export interface NetworkStatus {
  isOnline: boolean;
  since: Date;
  reconnectCount: number;
}

/**
 * useNetworkStatus monitors browser online/offline events, tracks connectivity duration,
 * and triggers an optional reconnect callback when network connectivity is restored.
 */
export function useNetworkStatus(onRestored?: () => void): NetworkStatus {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : true
  );
  const [since, setSince] = useState<Date>(() => new Date());
  const [reconnectCount, setReconnectCount] = useState<number>(0);

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    setSince(new Date());
    setReconnectCount((prev) => prev + 1);
    if (onRestored) {
      onRestored();
    }
  }, [onRestored]);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    setSince(new Date());
  }, []);

  useEffect(() => {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [handleOnline, handleOffline]);

  return {
    isOnline,
    since,
    reconnectCount,
  };
}
