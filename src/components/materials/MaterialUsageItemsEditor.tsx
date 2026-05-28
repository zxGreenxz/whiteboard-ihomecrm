import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MaterialPicker } from '@/components/materials/MaterialPicker';
import { useMaterials } from '@/hooks/useMaterials';

export interface UsageItemRow {
  key: string;
  material_id: string | null;
  quantity: string;
}

export const newUsageItemRow = (): UsageItemRow => ({
  key: crypto.randomUUID(),
  material_id: null,
  quantity: '',
});

interface Props {
  items: UsageItemRow[];
  onItemsChange: (items: UsageItemRow[]) => void;
  /**
   * Map material_id → quantity đang được tính trong tồn (cùng phiếu xuất hiện
   * tại). Khi user sửa qty mà new_qty <= on_hand + already_counted thì OK.
   * Để trống khi tạo mới.
   */
  existingQuantitiesByMaterial?: Record<string, number>;
}

export default function MaterialUsageItemsEditor({
  items,
  onItemsChange,
  existingQuantitiesByMaterial = {},
}: Props) {
  const { data: materials = [] } = useMaterials({});

  const updateItem = (key: string, patch: Partial<UsageItemRow>) => {
    onItemsChange(items.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const removeItem = (key: string) => {
    onItemsChange(items.length > 1 ? items.filter((r) => r.key !== key) : [newUsageItemRow()]);
  };
  const addItem = () => onItemsChange([...items, newUsageItemRow()]);

  const totalCost = items.reduce((sum, r) => {
    const m = materials.find((x) => x.id === r.material_id);
    const q = Number(r.quantity) || 0;
    return sum + q * Number(m?.avg_unit_cost ?? 0);
  }, 0);

  const isEmpty = items.every((r) => !r.material_id);

  return (
    <div>
      <div className="flex items-center justify-end mb-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addItem}
          className="h-7 gap-1"
        >
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
          const alreadyCounted = r.material_id ? (existingQuantitiesByMaterial[r.material_id] ?? 0) : 0;
          const over = m && q > Number(m.on_hand) + alreadyCounted;
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
    </div>
  );
}
