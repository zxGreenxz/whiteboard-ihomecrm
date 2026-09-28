// One implementation shared by the independent edge sweep and bounded tests.
export { parseLifecycleDelivery, runLifecycleReminders } from '../../../supabase/functions/lifecycle-reminders/runner';
export type { LifecycleDelivery, LifecycleRpc } from '../../../supabase/functions/lifecycle-reminders/runner';
export const LIFECYCLE_REMINDER_FAMILIES = ['NOTICE', 'TURNOVER', 'EXIT'] as const;
