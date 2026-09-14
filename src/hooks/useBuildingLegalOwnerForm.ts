import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { buildingLegalOwnerSchema, emptyBuildingLegalOwner, loadBuildingLegalOwner, saveBuildingLegalOwner, type BuildingLegalOwner } from '@/lib/buildingLegalOwner';

export function useBuildingLegalOwnerForm(buildingId: string | undefined, open: boolean) {
  const form = useForm<BuildingLegalOwner>({ resolver: zodResolver(buildingLegalOwnerSchema), defaultValues: emptyBuildingLegalOwner });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const isDirty = form.formState.isDirty;
  useEffect(() => {
    let active = true;
    form.reset(emptyBuildingLegalOwner);
    setError(null);
    setLoading(Boolean(open && buildingId));
    if (open && buildingId) {
      void loadBuildingLegalOwner(buildingId).then(owner => {
        if (active) form.reset(owner ?? emptyBuildingLegalOwner);
      }).catch(() => {
        if (active) setError('Không tải được chủ sở hữu pháp lý. Hãy tải lại trước khi lưu.');
      }).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [buildingId, open, form, reload]);
  return {
    form, loading, error, saving, retry: () => setReload(value => value + 1),
    validate: async () => !loading && !error && await form.trigger(),
    save: async (id: string, snapshot: BuildingLegalOwner = form.getValues()) => {
      if (!isDirty) return;
      setSaving(true);
      try {
        const owner = buildingLegalOwnerSchema.parse(snapshot);
        await saveBuildingLegalOwner(id, owner);
        form.reset(owner);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : 'Chưa lưu được chủ sở hữu pháp lý.');
        throw cause;
      } finally { setSaving(false); }
    },
  };
}
