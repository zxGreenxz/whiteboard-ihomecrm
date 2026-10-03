import { z } from 'zod';
import { vnClock, type PersonalTask } from './model';

const settingsSchema = z.object({
  enabled: z.boolean(), enabledAt: z.number().finite().nonnegative(),
  before: z.number().refine(n => [5, 10, 15, 30, 60].includes(n)).nullable(),
  after: z.number().refine(n => [0, 15, 30, 60].includes(n)).nullable(),
  morning: z.enum(['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00']).nullable(),
  sound: z.boolean(), tone: z.enum(['tintin', 'dingdong', 'bell']),
});
const envelope = z.object({ version: z.literal(1), settings: settingsSchema });
export type ReminderSettings = z.infer<typeof settingsSchema>;
export const defaultReminders: ReminderSettings = { enabled: false, enabledAt: 0, before: null, after: 0, morning: null, sound: true, tone: 'tintin' };
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const reminderKey = (userId: string) => `ihomecrm:personal-reminders:v1:${userId}`;
export function readReminders(storage: LocalStorage, userId: string): ReminderSettings {
  const raw = storage.getItem(reminderKey(userId));
  return raw === null ? { ...defaultReminders } : envelope.parse(JSON.parse(raw)).settings;
}
export function saveReminders(storage: LocalStorage, userId: string, settings: ReminderSettings) {
  storage.setItem(reminderKey(userId), JSON.stringify(envelope.parse({ version: 1, settings })));
}
export type ReminderEvent = { id: string; kind: 'before' | 'due' | 'morning'; at: number; title: string; body: string };
/** Page timers can be suspended. Only catch up within one minute, never replay an old backlog. */
export function dueReminders(tasks: PersonalTask[], settings: ReminderSettings, now: number): ReminderEvent[] {
  if (!settings.enabled) return [];
  const events: ReminderEvent[] = [];
  const recent = (at: number) => at <= now && at > now - 60_000 && at >= settings.enabledAt;
  for (const task of tasks) {
    if (task.status !== 'doing' || !task.due) continue;
    const due = Date.parse(`${task.due.iso}T${task.due.time}:00+07:00`);
    for (const kind of ['before', 'due'] as const) {
      const minutes = kind === 'before' ? settings.before : settings.after;
      if (minutes === null) continue;
      const at = due + (kind === 'before' ? -minutes : minutes) * 60_000;
      if (recent(at)) events.push({ id: `${task.id}:${due}:${kind}:${minutes}`, kind, at,
        title: kind === 'before' ? `Còn ${minutes} phút đến hẹn` : minutes === 0 ? 'Đã đến giờ hẹn' : `Đã quá hẹn ${minutes} phút`, body: task.text });
    }
  }
  const open = tasks.filter(task => task.status !== 'done');
  if (settings.morning && open.length) {
    const day = vnClock(new Date(now)).day;
    const at = Date.parse(`${day}T${settings.morning}:00+07:00`);
    const doing = open.filter(task => task.status === 'doing').length;
    if (recent(at)) events.push({ id: `morning:${day}`, kind: 'morning', at, title: 'Điểm việc buổi sáng', body: `Bạn còn ${open.length} việc: ${open.length - doing} cần làm · ${doing} đang xử lý.` });
  }
  return events.sort((a, b) => a.at - b.at);
}

const ledgerSchema = z.record(z.string(), z.number().finite());
/** Caller holds the account Web Lock. Reserve before delivery so storage failure cannot spam notifications. */
export async function deliverReminder(storage: LocalStorage, userId: string, event: ReminderEvent, now: number, deliver: () => Promise<void>) {
  const key = `${reminderKey(userId)}:delivered`;
  const raw = storage.getItem(key);
  const previous = raw === null ? {} : ledgerSchema.parse(JSON.parse(raw));
  if (Object.prototype.hasOwnProperty.call(previous, event.id)) return false;
  const ledger = Object.fromEntries(Object.entries(previous).filter(([, at]) => at > now - 172800_000));
  storage.setItem(key, JSON.stringify({ ...ledger, [event.id]: now }));
  try { await deliver(); }
  catch (error) { storage.setItem(key, JSON.stringify(ledger)); throw error; }
  return true;
}
