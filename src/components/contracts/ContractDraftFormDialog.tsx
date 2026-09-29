import type { ContractDraft } from '@/lib/contractDrafts';
import { ContractFormDialog, type ContractPrefill } from './ContractFormDialog';

export interface ContractDraftFormDialogProps {
  open: boolean; onOpenChange: (open: boolean) => void; draft?: ContractDraft;
  prefill?: ContractPrefill; canExport?: boolean; onSaved?: (draft: ContractDraft) => void;
}

/** Draft list entry uses the same editor as the normal Create contract action. */
export function ContractDraftFormDialog(props: ContractDraftFormDialogProps) {
  return <ContractFormDialog {...props} />;
}
