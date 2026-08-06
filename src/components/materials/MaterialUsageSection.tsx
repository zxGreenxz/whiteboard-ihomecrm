import { useEffect, useState, useMemo } from 'react';
import { Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMaterialUsageByJob, useUpsertJobMaterialUsage } from '@/hooks/useMaterialUsages';
import { useMaterials } from '@/hooks/useMaterials';
import { todayISO } from '@/lib/collect';
import MaterialUsageItemsEditor, {
  type UsageItemRow,
  newUsageItemRow,
} from '@/components/materials/MaterialUsageItemsEditor';

interface Props {
  jobId: string;
  className?: string;
}

export default function MaterialUsageSection({ jobId, className }: Props) {
  const { data: usage } = useMaterialUsageByJob(jobId);
  const { data: materials = [] } = useMaterials({});
  const upsert = useUpsertJobMaterialUsage();

  const [items, setItems] = useState<UsageItemRow[]>([newUsageItemRow()]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
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
    const clean = items
      .map((r) => {
        const m = materials.find((x) => x.id === r.material_id);
        return {
          material_id: r.material_id ?? '',
          quantity: Number(r.quantity) || 0,
          unit_cost_at_usage: Number(m?.avg_unit_cost ?? 0),
        };
      })
      .filter((it) => it.material_id && it.quantity > 0);

    try {
      await upsert.mutateAsync({
        job_id: jobId,
        usage_date: todayISO(),
        notes: null,
        items: clean,
      });
      setDirty(false);
    } catch {
      /* toast in hook */
    }
  };

  return (
    <div className={className}>
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
      <MaterialUsageItemsEditor
        items={items}
        onItemsChange={(next) => {
          setItems(next);
          setDirty(true);
        }}
        existingQuantitiesByMaterial={existingMap}
      />
      {dirty && (
        <div className="flex justify-end mt-2">
          <Button size="sm" onClick={onSave} disabled={upsert.isPending}>
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
