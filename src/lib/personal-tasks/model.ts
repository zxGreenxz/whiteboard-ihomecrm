import { z } from 'zod';
import { diffDaysISO, vnTodayISO } from '@/lib/vnDate';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value =>
  value >= '1900-01-01' && value <= '2199-12-31' && diffDaysISO(value, value) === 0, 'Ngày không hợp lệ');
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Giờ không hợp lệ');
export const textSchema = z.string().trim().min(1, 'Nhập nội dung công việc').max(500, 'Tối đa 500 ký tự');
export const dueSchema = z.object({ iso: dateSchema, time: timeSchema });
export const taskSchema = z.object({
  id: z.string().min(1), text: textSchema, day: dateSchema,
  status: z.enum(['todo', 'doing', 'done']), due: dueSchema.nullable(),
  doneAt: dateSchema.nullable(), doneTime: timeSchema.nullable(),
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
}).refine(task => task.status !== 'doing' || task.due !== null)
  .refine(task => task.status !== 'done' || (task.doneAt !== null && task.doneTime !== null));
export type PersonalTask = z.infer<typeof taskSchema>;
export type TaskStatus = PersonalTask['status'];
export type TaskAction = { type: 'done' | 'todo' } | { type: 'due'; due: z.infer<typeof dueSchema> };

export function vnClock(now = new Date()) {
  return { day: vnTodayISO(now), time: new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now) };
}
export function createTask(id: string, text: string, now = new Date()): PersonalTask {
  return taskSchema.parse({ id, text, day: vnTodayISO(now), status: 'todo', due: null,
    doneAt: null, doneTime: null, createdAt: now.getTime(), updatedAt: now.getTime() });
}
export function transitionTask(task: PersonalTask, action: TaskAction, now = new Date()): PersonalTask {
  const clock = vnClock(now);
  const next = { ...task, updatedAt: now.getTime() };
  if (action.type === 'done') return taskSchema.parse({ ...next, status: 'done', doneAt: clock.day, doneTime: clock.time });
  return taskSchema.parse({ ...next, status: action.type === 'due' ? 'doing' : 'todo',
    due: action.type === 'due' ? action.due : null, doneAt: null, doneTime: null });
}
export function isOverdue(task: PersonalTask, now: Date): boolean {
  const clock = vnClock(now);
  return task.status === 'doing' && !!task.due && `${task.due.iso} ${task.due.time}` < `${clock.day} ${clock.time}`;
}
export function deriveTasks(tasks: PersonalTask[], today: string) {
  const stable = (a: PersonalTask, b: PersonalTask) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
  const todo = tasks.filter(t => t.status === 'todo').sort(stable);
  const doing = tasks.filter(t => t.status === 'doing').sort((a, b) =>
    `${a.due?.iso} ${a.due?.time}`.localeCompare(`${b.due?.iso} ${b.due?.time}`) || stable(a, b));
  const done = tasks.filter(t => t.status === 'done').sort((a, b) =>
    `${b.doneAt} ${b.doneTime}`.localeCompare(`${a.doneAt} ${a.doneTime}`) || b.updatedAt - a.updatedAt || stable(a, b));
  const doneToday = done.filter(t => t.doneAt === today);
  const todoGroups = [...new Set([...todo, ...doneToday].map(t => t.day))].sort().map(day => ({
    day, open: todo.filter(t => t.day === day), completed: doneToday.filter(t => t.day === day),
  }));
  const doneGroups = [...new Set(done.map(t => t.doneAt!))].sort().reverse().map(day => ({ day, tasks: done.filter(t => t.doneAt === day) }));
  return { counts: { todo: todo.length, doing: doing.length, done: done.length }, todoGroups, doing, doneGroups };
}
