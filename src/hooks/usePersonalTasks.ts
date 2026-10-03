import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { createTask, transitionTask, type PersonalTask, type TaskAction } from '@/lib/personal-tasks/model';
import { readTasks, storageKey, updateTasks } from '@/lib/personal-tasks/storage';

const READ_ERROR = 'Không đọc được việc đã lưu trên thiết bị. Dữ liệu gốc vẫn được giữ. Hãy thử tải lại.';
export function usePersonalTasks(userId: string) {
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(() => {
    try { setTasks(readTasks(window.localStorage, userId)); setError(null); }
    catch { setError(READ_ERROR); }
    finally { setLoading(false); }
  }, [userId]);
  useEffect(() => {
    mounted.current = true;
    refresh();
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === storageKey(userId)) refresh(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', refresh);
    return () => { mounted.current = false; window.removeEventListener('storage', onStorage); window.removeEventListener('focus', refresh); };
  }, [refresh, userId]);

  const mutate = async (update: (value: PersonalTask[]) => PersonalTask[]) => {
    if (pending.current || loading || error) return false;
    pending.current = true;
    setBusy(true);
    try {
      const write = () => {
        if (!mounted.current) return;
        const saved = updateTasks(window.localStorage, userId, update);
        setTasks(saved);
      };
      if (navigator.locks) await navigator.locks.request(storageKey(userId), write);
      else write();
      return mounted.current;
    } catch {
      toast.error('Chưa lưu được công việc. Kiểm tra dung lượng hoặc quyền lưu trữ của trình duyệt rồi thử lại.');
      return false;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { tasks, error, loading, busy, refresh,
    add: (text: string) => mutate(value => [...value, createTask(crypto.randomUUID(), text)]),
    remove: (id: string) => mutate(value => value.filter(task => task.id !== id)),
    change: (id: string, action: TaskAction) => mutate(value => {
      if (!value.some(task => task.id === id)) throw new Error('Task no longer exists');
      return value.map(task => task.id === id ? transitionTask(task, action) : task);
    }),
  };
}
