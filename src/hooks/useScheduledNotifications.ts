/**
 * Hook to run scheduled notification checks
 *
 * This hook should be called in the main app component to check for
 * scheduled notifications (contract expiry, payment reminders, overdue invoices)
 *
 * It runs once on mount and then every 6 hours
 */

import { useEffect } from 'react';
import { useAuth } from './useAuth';
import { runScheduledNotifications } from '@/lib/notificationScheduler';

export function useScheduledNotifications() {
  const { data: user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    // Run immediately on mount
    runScheduledNotifications(user.id);

    // Run every 6 hours (6 * 60 * 60 * 1000 ms)
    const interval = setInterval(() => {
      runScheduledNotifications(user.id);
    }, 6 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, [user?.id]);
}
