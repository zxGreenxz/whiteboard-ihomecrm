import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { friendlyError } from '@/lib/friendlyError';
import { applyFeedbackToForm } from '@/lib/formErrors';
import { buildingLegalOwnerSchema, emptyBuildingLegalOwner, loadBuildingLegalOwner, saveBuildingLegalOwner, type BuildingLegalOwner } from '@/lib/buildingLegalOwner';

export function useBuildingLegalOwnerForm(buildingId: string | undefined, open: boolean) {
  const form = useForm<BuildingLegalOwner>({ resolver: zodResolver(buildingLegalOwnerSchema), defaultValues: emptyBuildingLegalOwner });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const needsReconcile = useRef(false);
  const [reload, setReload] = useState(0);
  const isDirty = form.formState.isDirty;
  useEffect(() => {
    let active = true;
    needsReconcile.current = false;
    form.reset(emptyBuildingLegalOwner);
    setError(null);
    setLoading(Boolean(open && buildingId));
    if (open && buildingId) {
      void loadBuildingLegalOwner(buildingId).then(owner => {
        if (active) form.reset(owner ?? emptyBuildingLegalOwner);
      }).catch(cause => {
        if (active) { const feedback = friendlyError(cause, 'Chưa tải được chủ sở hữu pháp lý.', {operation:'xem chủ sở hữu pháp lý'}); setError(`${feedback.title} ${feedback.description}`); }
      }).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [buildingId, open, form, reload]);
  return {
    form, loading, error, saving, retry: () => setReload(value => value + 1),
    validate: async () => !loading && !error && await form.trigger(undefined, {shouldFocus: true}),
    save: async (id: string, snapshot: BuildingLegalOwner = form.getValues(), reconcile = false) => {
      if (!isDirty && !reconcile) return;
      setSaving(true);
      form.clearErrors('root.server');
      try {
        const owner = buildingLegalOwnerSchema.parse(snapshot);
        if (needsReconcile.current || reconcile) {
          const current = await loadBuildingLegalOwner(id);
          if (current && JSON.stringify(current) === JSON.stringify(owner)) {
            form.reset(owner);
            needsReconcile.current = false;
            return;
          }
        }
        if(reconcile && !isDirty && JSON.stringify(owner)===JSON.stringify(emptyBuildingLegalOwner)) {
          const current=await loadBuildingLegalOwner(id);
          if(current!==null)throw new Error('Nhập lại thông tin chủ đã dự định lưu để đối chiếu, hoặc mở tòa đã lưu.');
          return;
        }
        await saveBuildingLegalOwner(id, owner);
        form.reset(owner);
        needsReconcile.current = false;
      } catch (cause) {
        needsReconcile.current = true;
        const feedback = cause instanceof z.ZodError
          ? {description:'Kiểm tra các ô chủ sở hữu được đánh dấu.', fieldErrors:Object.fromEntries(cause.issues.map(issue=>[issue.path.join('.'), issue.message]))}
          : friendlyError(cause, 'Chưa lưu được chủ sở hữu pháp lý.', {operation:'lưu chủ sở hữu pháp lý'});
        await applyFeedbackToForm(form, feedback);
        throw cause;
      } finally { setSaving(false); }
    },
  };
}
