import { z } from 'zod';
import { taskSchema, type PersonalTask } from './model';

const envelope = z.object({ version: z.literal(1), tasks: z.array(taskSchema) })
  .refine(data => new Set(data.tasks.map(t => t.id)).size === data.tasks.length);
type TaskStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const storageKey = (userId: string) => `ihomecrm:personal-tasks:v1:${userId}`;

export function readTasks(storage: TaskStorage, userId: string): PersonalTask[] {
  const raw = storage.getItem(storageKey(userId));
  if (raw === null) return [];
  return envelope.parse(JSON.parse(raw)).tasks;
}
export function serializeTasks(tasks: PersonalTask[]): string {
  return JSON.stringify(envelope.parse({ version: 1, tasks }), null, 2);
}
/** Call inside the account's Web Lock. Never replace unreadable data with an empty list. */
export function updateTasks(storage: TaskStorage, userId: string, update: (tasks: PersonalTask[]) => PersonalTask[]): PersonalTask[] {
  const tasks = update(readTasks(storage, userId));
  storage.setItem(storageKey(userId), serializeTasks(tasks));
  return tasks;
}
