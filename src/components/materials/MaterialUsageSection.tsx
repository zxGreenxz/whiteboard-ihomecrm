import { useEffect, useState } from 'react';
import { Plus, Trash2, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MaterialPicker } from '@/components/materials/MaterialPicker';
import {
  useMaterialUsageByJob,
  useUpsertJobMaterialUsage,
} from '@/hooks/useMaterialUsages';
import { useMaterials } from '@/hooks/useMaterials';
import { toast } from 'sonner';

interface Props {
  jobId: string;
  className?: string;
}

interface ItemRow {
  key: string;
  material_id: string | null;
  quantity: string;
}

const newRow = (): ItemRow => ({
  key: crypto.randomUUID(),
  material_id: null,
  quantity: '',
});

export default function MaterialUsageSection({ jobId, className }: Props) {
  const { data: usage } = useMaterialUsageByJob(jobId);
  const { data: materials = [] } = useMaterials({});
  const upsert = useUpsertJobMaterialUsage();

  const [items, setItems] = useState<ItemRow[]>([newRow()]);
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
      setItems([newRow()]);
    }
    setDirty(false);
  }, [usage?.id, usage?.items.length]);

  const totalCost = items.reduce((sum, r) => {
    const m = materials.find((x) => x.id === r.material_id);
    const q = Number(r.quantity) || 0;
    return sum + q * Number(m?.avg_unit_cost ?? 0);
  }, 0);

  const updateItem = (key: string, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const removeItem = (key: string) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : [newRow()]));
    setDirty(true);
  };
  const addItem = () => {
    setItems((prev) => [...prev, newRow()]);
    setDirty(true);
  };

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
        usage_date: new Date().toISOString().slice(0, 10),
        notes: null,
        items: clean,
      });
      setDirty(false);
    } catch {
      /* toast in hook */
    }
  };

  const isEmpty = items.every((r) => !r.material_id);

  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Package className="h-4 w-4" />
          Vật tư đã sử dụng
          {usage?.code && (
            <span className="font-mono text-xs text-muted-foreground">({usage.code})</span>
          )}
        </h3>
        <Button size="sm" variant="outline" onClick={addItem} className="h-7 gap-1">
          <Plus className="h-3.5 w-3.5" />
          Thêm
        </Button>
      </div>

      <div className="border rounded-md divide-y">
        <div className="grid grid-cols-12 gap-2 px-2 py-1.5 bg-muted/40 text-xs font-medium text-muted-foreground">
          <div className="col-span-7">Vật tư</div>
          <div className="col-span-3 text-right">Số lượng</div>
          <div className="col-span-2" />
        </div>
        {items.map((r) => {
          const m = materials.find((x) => x.id === r.material_id);
          const q = Number(r.quantity) || 0;
          const over = m && q > Number(m.on_hand) + (usage?.items.find((i) => i.material_id === r.material_id)?.quantity ?? 0);
          return (
            <div key={r.key} className="grid grid-cols-12 gap-2 px-2 py-1.5 items-center">
              <div className="col-span-7">
                <MaterialPicker
                  value={r.material_id}
                  onChange={(id) => updateItem(r.key, { material_id: id })}
                  showStock
                />
              </div>
              <div className="col-span-3">
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={r.quantity}
                  onChange={(e) => updateItem(r.key, { quantity: e.target.value })}
                  className={`text-right h-8 ${over ? 'border-amber-500 focus-visible:ring-amber-500' : ''}`}
                  placeholder="0"
                />
              </div>
              <div className="col-span-2 flex justify-end gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-red-600 hover:text-red-700"
                  onClick={() => removeItem(r.key)}
                  disabled={items.length === 1 && !r.material_id}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        {!isEmpty && (
          <div className="px-2 py-1.5 flex items-center justify-end gap-2 bg-muted/20 text-xs">
            <span className="text-muted-foreground">Chi phí ước tính:</span>
            <span className="font-mono font-semibold">{totalCost.toLocaleString('vi-VN')} đ</span>
          </div>
        )}
      </div>

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
