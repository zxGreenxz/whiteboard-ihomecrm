import { useEffect, useState, useMemo, useRef } from 'react';
import { Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMaterialUsageByJob, useUpsertJobMaterialUsage } from '@/hooks/useMaterialUsages';
import { useMaterials } from '@/hooks/useMaterials';
import { todayISO } from '@/lib/collect';
import { validateMaterialUsageRows } from '@/lib/materialUsageValidation';
import { focusFirstError } from '@/lib/formErrors';
import { materialVoucherFailureMessage, materialVoucherRetryBlocked } from '@/lib/materialVoucherOutcome';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { validateInputDrafts } from '@/lib/inputDraftValidation';
import MaterialUsageItemsEditor, {
  type UsageItemRow,
  newUsageItemRow,
} from '@/components/materials/MaterialUsageItemsEditor';

interface Props {
  jobId: string;
  className?: string;
}

export default function MaterialUsageSection({ jobId, className }: Props) {
  const root=useRef<HTMLDivElement|null>(null);
  const usageQuery = useMaterialUsageByJob(jobId);
  const usage = usageQuery.data;
  const materialsQuery = useMaterials({});
  const materials = materialsQuery.data ?? [];
  const upsert = useUpsertJobMaterialUsage();

  const [items, setItems] = useState<UsageItemRow[]>([newUsageItemRow()]);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rootError, setRootError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (dirty || rootError || blocked) return;
    if (usage && usage.items.length > 0) {
      setItems(
        usage.items.map((it) => ({
          key: it.id,
          material_id: it.material_id,
          quantity: String(it.quantity),
        })),
      );
    } else {
      setItems([newUsageItemRow()]);
    }
    setDirty(false);
  }, [usage?.id, usage?.items.length]);

  const existingMap = useMemo(() => {
    const map: Record<string, number> = {};
    for (const it of usage?.items ?? []) {
      map[it.material_id] = Number(it.quantity);
    }
    return map;
  }, [usage?.items]);

  const savedCost = (usage?.items ?? []).reduce(
    (sum, it) => sum + Number(it.quantity) * Number(it.unit_cost_at_usage),
    0,
  );

  const onSave = async () => {
    if(!validateInputDrafts(root.current))return;
    if (blocked || saving || upsert.isPending) return;
    if (usageQuery.isPending || usageQuery.isError || materialsQuery.isPending || materialsQuery.isError) { setRootError('Chưa tải được phiếu vật tư hoặc tồn kho. Tải lại trước khi lưu.'); return; }
    const rowErrors = validateMaterialUsageRows(items, { optional: true });
    items.forEach((row, index) => {
      if (row.material_id && !materials.some(material => material.id === row.material_id)) rowErrors[`materials.${index}.material_id`] = 'Chọn lại vật tư có trong danh sách.';
    });
    if (Object.keys(rowErrors).length) { setErrors(rowErrors); void focusFirstError(rowErrors, { order: ['materials'] }); return; }
    const untouched = items.every(row => !row.material_id && !row.quantity.trim());
    const clean = untouched ? [] : items.map(row => {
      const material = materials.find(item => item.id === row.material_id)!;
      return { material_id: row.material_id!, quantity: Number(row.quantity), unit_cost_at_usage: Number(material.avg_unit_cost ?? 0) };
    });
    setErrors({}); setRootError(''); setSaving(true);
    try {
      await upsert.mutateAsync({ job_id: jobId, usage_date: todayISO(), notes: null, items: clean });
      setDirty(false);
    } catch (error) {
      const ids = error instanceof FinancialWorkflowError ? error.completed.map(step => step.id) : [];
      setRootError(materialVoucherFailureMessage(error, 'lưu vật tư công việc') + (ids.length ? ` ID cần đối chiếu: ${ids.join(', ')}.` : ''));
      setBlocked(materialVoucherRetryBlocked(error));
    } finally { setSaving(false); }
  };
  return (
    <div ref={root} className={className}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Package className="h-4 w-4" />
          Vật tư đã sử dụng
          {usage?.code && (
            <span className="font-mono text-xs text-muted-foreground">({usage.code})</span>
          )}
          {savedCost > 0 && !dirty && (
            <span className="text-xs text-muted-foreground font-normal">
              · Chi phí: <b className="font-mono text-foreground">{savedCost.toLocaleString('vi-VN')} đ</b>
            </span>
          )}
        </h3>
      </div>
      {rootError && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{rootError}</p>}
      {(usageQuery.isError || materialsQuery.isError) && <Button type="button" variant="outline" onClick={() => { void usageQuery.refetch(); void materialsQuery.refetch(); }}>Tải lại vật tư</Button>}
      <fieldset disabled={saving || upsert.isPending || blocked}>
      <MaterialUsageItemsEditor
        items={items} errors={errors}
        onItemsChange={(next) => {
          setItems(next);
          setDirty(true); setErrors({});
        }}
        existingQuantitiesByMaterial={existingMap}
      />
      </fieldset>
      {dirty && (
        <div className="flex justify-end mt-2">
          <Button size="sm" onClick={onSave} disabled={saving || upsert.isPending || blocked || usageQuery.isPending || usageQuery.isError || materialsQuery.isPending || materialsQuery.isError}>
            {upsert.isPending ? 'Đang lưu…' : 'Lưu vật tư'}
          </Button>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground mt-1.5">
        Khi lưu, tồn kho sẽ tự động trừ. Giá vốn snapshot tại thời điểm xuất.
      </p>
    </div>
  );
}
