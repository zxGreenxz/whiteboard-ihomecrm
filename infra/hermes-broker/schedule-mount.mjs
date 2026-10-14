import { createBoundUserOperationService } from './bound-user-operation.mjs';
import { createSupabaseScheduleReads } from './schedule-adapter.mjs';
import { mayUseSchedule, scheduleInput, scheduleResult } from './schedule-contract.mjs';

export function createScheduleMount({ authority, connectionStore, crypto, auth, supabase, dependencyScope, fetch, clock = Date.now } = {}) {
  const reads = createSupabaseScheduleReads({ ...supabase, dependencyScope, fetch });
  return Object.freeze({ authority, createService() {
    const service = createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads,
      mayUse: mayUseSchedule, validateInput: (operation, input) => scheduleInput(operation, input, clock()),
      validateResult: scheduleResult, clock });
    return Object.freeze({ prepareSchedule: service.prepare, finalizeSchedule: service.finalize });
  } });
}
