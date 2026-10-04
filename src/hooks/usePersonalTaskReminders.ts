import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createReminderAudio } from '@/lib/personal-tasks/reminderAudio';
import { defaultReminders, deliverReminder, dueReminders, readReminders, reminderKey, saveReminders, type ReminderSettings } from '@/lib/personal-tasks/reminders';
import { readTasks, storageKey } from '@/lib/personal-tasks/storage';

function permission(): NotificationPermission | 'unsupported' {
  return window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator ? Notification.permission : 'unsupported';
}
async function registration() {
  const existing = await navigator.serviceWorker.getRegistration('/');
  const registered = existing ?? await navigator.serviceWorker.register('/sw.js');
  if (registered.active) return registered;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Service worker activation timed out')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

export function usePersonalTaskReminders(userId: string) {
  const [settings, setSettings] = useState<ReminderSettings>(defaultReminders);
  const [access, setAccess] = useState(permission);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const audio = useRef<ReturnType<typeof createReminderAudio> | null>(null);
  const refresh = useCallback(() => {
    setAccess(permission());
    try { setSettings(readReminders(localStorage, userId)); setError(null); }
    catch { setError('Không đọc được cài đặt nhắc hẹn. Bản đã lưu vẫn được giữ; hãy tải lại trang.'); }
  }, [userId]);
  useEffect(() => {
    alive.current = true;
    audio.current = createReminderAudio();
    refresh();
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === reminderKey(userId)) refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', onStorage);
    return () => { alive.current = false; audio.current?.close(); audio.current = null; window.removeEventListener('focus', refresh); window.removeEventListener('storage', onStorage); };
  }, [refresh, userId]);

  const update = async (patch: Partial<ReminderSettings>) => {
    const write = () => {
      if (!alive.current) return;
      const next = { ...readReminders(localStorage, userId), ...patch };
      saveReminders(localStorage, userId, next);
      setSettings(next); setError(null);
    };
    if (navigator.locks) await navigator.locks.request(reminderKey(userId), write); else write();
  };
  const save = async (patch: Partial<ReminderSettings>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await update(patch); }
    catch { if (alive.current) setError('Chưa lưu được cài đặt. Kiểm tra quyền lưu trữ hoặc dung lượng rồi thử lại.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const enable = async () => {
    if (pending.current || permission() === 'unsupported') return;
    pending.current = true; setBusy(true);
    // Both APIs must start in this click handler, before awaiting anything else.
    void audio.current?.unlock().catch(() => {
      if (alive.current) toast.error('Chưa bật được chuông tùy chọn. Bạn vẫn có thể nhận thông báo hệ thống và bấm Nghe thử để thử lại.');
    });
    try {
      const granted = permission() === 'granted' ? 'granted' : await Notification.requestPermission();
      if (!alive.current) return;
      setAccess(granted);
      if (granted !== 'granted') return;
      await registration();
      if (alive.current) await update({ enabled: true, enabledAt: Date.now() });
    } catch { if (alive.current) setError('Chưa bật được thông báo trên máy này. Hãy kiểm tra quyền thông báo và thử lại.'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const preview = async () => {
    try { await audio.current?.unlock(); if (!audio.current?.play(settings.tone)) throw new Error('Audio unavailable'); }
    catch { if (alive.current) toast.error('Chưa phát được âm thanh. Kiểm tra âm lượng và quyền âm thanh của trình duyệt.'); }
  };

  useEffect(() => {
    if (!settings.enabled || access !== 'granted' || error) return;
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const run = async () => {
          if (stopped || !alive.current || permission() !== 'granted') return;
          const current = readReminders(localStorage, userId);
          const tasks = readTasks(localStorage, userId);
          const events = dueReminders(tasks, current, Date.now());
          if (!events.length) return;
          const reg = await registration();
          for (const event of events) {
            if (stopped || !alive.current) return;
            // Another tab may complete/delete a task while the worker activates.
            const latest = readReminders(localStorage, userId);
            if (!dueReminders(readTasks(localStorage, userId), latest, Date.now()).some(item => item.id === event.id)) continue;
            await deliverReminder(localStorage, userId, event, Date.now(), async () => {
              const audible = latest.sound && audio.current?.play(latest.tone);
              await reg.showNotification(`Việc của tôi · ${event.title}`, {
                body: event.body, icon: '/pwa-192.png', badge: '/pwa-192.png',
                tag: `personal-task:${userId}:${event.id}`, silent: !latest.sound || !!audible,
                data: { url: '/viec-cua-toi' },
              });
              if (!stopped && document.visibilityState === 'visible') toast(event.title, { description: event.body });
            });
          }
        };
        // The same lock serializes delivery across all tabs of this account.
        if (navigator.locks) await navigator.locks.request(reminderKey(userId), run); else await run();
      } catch {
        if (!stopped && alive.current) setError('Nhắc hẹn đã tạm dừng vì chưa gửi được thông báo hoặc chưa lưu được lịch nhắc. Bấm Thử lại.');
        stopped = true;
      } finally { running = false; }
    };
    const wake = () => { void tick(); };
    const storageChanged = (event: StorageEvent) => { if (event.key === storageKey(userId)) wake(); };
    wake();
    const timer = window.setInterval(wake, 15_000);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('storage', storageChanged);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); window.removeEventListener('storage', storageChanged); };
  }, [access, error, settings, userId]);
  return { settings, access, error, busy, save, enable, preview, retry: refresh };
}
