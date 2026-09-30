import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { CopilotAccountMissingError, CopilotAdminUnknownError } from './adminWrites';
// Only exact codes already mapped to verified SQL/client preflight rules may release a marker.
const knownRejections = new Set(['unauthenticated', 'organization_required', 'not_permitted', 'reauth_failed', 'reset_confirm_required', 'copilot_policy_missing', 'copilot_policy_not_permitted', 'copilot_policy_risk_invalid', 'copilot_policy_roles_invalid', 'copilot_policy_stale_revision', 'policy_reason_required', 'pin_format', 'pin_weak', 'pin_not_set', 'pin_locked', 'pin_invalid', 'step_up_superadmin_only', 'step_up_reset_self_forbidden', 'user_required', 'reason_required', 'standing_grant_not_permitted', 'grant_expires_invalid', 'grant_max_per_day_invalid', 'grant_action_required', 'grant_constraints_invalid', 'grant_already_revoked', 'grant_not_found', 'grant_reason_required', 'step_up_required']);
/** Global admin authorization stays on the server; coordination remains stable if selected org changes. */
export async function runPersistentCopilotAdminWrite<T>(key: string, operation: string, task: () => Promise<T>): Promise<T> {
 const workflow = persistentFinancialWorkflow('copilot-admin', { scope: 'actor' });
 try {
  return await workflow.run(key, operation, async () => {
   try { return await task(); }
   catch (error) {
    if (error instanceof CopilotAdminUnknownError) throw new FinancialWorkflowError(error.message, 'unknown', error.receiptIds.map(id => ({ id, label: 'Mã cần đối chiếu' })), error);
    if (error instanceof CopilotAccountMissingError || error instanceof Error && knownRejections.has(error.message)) throw new FinancialWorkflowError('Kiểm tra lại thông tin và quyền thực hiện thao tác.', 'failure', [], error);
    throw error;
   }
  });
 } catch (error) {
  // Return confirmed business failures to their existing, field-specific owner.
  if (error instanceof FinancialWorkflowError && error.outcome === 'failure' && error.cause) throw error.cause;
  throw error;
 }
}
