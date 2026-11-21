import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AdvanceResult } from '@/lib/profitLedger/positionReaders';
import {
  describeOwnerPayoutFailure, ownerPayoutCanResume, useOwnerPayoutPosting,
  type OwnerPayoutTarget, type OwnerPayoutStepFailure,
} from './useOwnerPayoutPosting';

type Receipt = AdvanceResult & { code: string | null };

export function useOwnerAdvancePosting(open: boolean, owner: boolean, accountId: string) {
  const [created, setCreated] = useState<{ target: OwnerPayoutTarget; code: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OwnerPayoutStepFailure | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const saving = useRef(false);
  const active = open && (owner || !!created);
  const posting = useOwnerPayoutPosting(active, 'distribute');
  useEffect(() => {
    if (!open) { setCreated(null); setFailure(null); setEvidenceError(null); }
  }, [open]);
  const step = created?.target.step ?? posting.stepFor(accountId);
  const label = created ? 'Làm tiếp trên phiếu đã lập' : step === 'APPROVE_AND_POST' ? 'Duyệt và Chi' : step === null ? 'Lập phiếu chờ duyệt' : 'Lập phiếu và duyệt';
  const disabled = step === undefined || (!!failure && !ownerPayoutCanResume(failure));

  async function save(create: () => Promise<Receipt>, organizationId: string, postedOn: string) {
    if (saving.current || step === undefined || disabled) return false;
    saving.current = true;
    setBusy(true);
    setEvidenceError(null);
    try {
      if (step === 'APPROVE_AND_POST') {
        const error = await posting.evidence.ensureReady(label);
        if (error !== null) { setEvidenceError(error); return false; }
      }
      let current = created;
      if (!current) {
        const result = await create();
        if (result.maker_kind !== 'OWNER' || step === null) {
          toast.info('Đã lập phiếu tạm ứng, đang chờ người có quyền duyệt.');
          return true;
        }
        current = { code: result.code, target: { voucherId: result.voucher_id, organizationId, accountId, postedOn, step } };
        setCreated(current);
      }
      try {
        const outcome = await posting.complete(current.target);
        toast.success(`Phiếu tạm ứng ${current.code ?? ''} ${outcome === 'POSTED' ? 'đã duyệt và ghi chi' : 'đã duyệt, chờ người giữ sổ chi'}.`);
        return true;
      } catch (error) {
        const issue = describeOwnerPayoutFailure(error, current.target.step);
        if (issue.kind === 'APPROVE_ONLY') {
          setCreated({ ...current, target: { ...current.target, step: 'APPROVE' } });
          setFailure({ kind: 'RETRY', message: 'Chỉ được duyệt phiếu này. Bấm Làm tiếp để duyệt và chuyển người giữ sổ chi.' });
        } else setFailure(issue);
        return false;
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return {
    active, busy, disabled, label, save, created,
    section: { posting, accountId, accountName: null, evidenceError, disabled: busy,
      created: created ? { code: created.code, step: created.target.step } : null, stepFailure: failure },
  };
}
