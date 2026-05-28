import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MaterialPicker } from '@/components/materials/MaterialPicker';
import { useCreateMaterialAdjustment, useSetMaterialStock } from '@/hooks/useMaterialAdjustments';
import { useMaterials } from '@/hooks/useMaterials';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type AdjType = 'IN' | 'OUT' | 'SET';

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

export default function MaterialAdjustmentFormDialog({ open, onOpenChange }: Props) {
  const createMut = useCreateMaterialAdjustment();
  const setStock = useSetMaterialStock();
  const { data: materials = [] } = useMaterials({});

  const [type, setType] = useState<AdjType>('SET');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<ItemRow[]>([newRow()]);

  useEffect(() => {
    if (open) {
      setType('SET');
      setDate(new Date().toISOString().slice(0, 10));
      setReason('');
      setItems([newRow()]);
    }
  }, [open]);

  const updateItem = (key: string, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const removeItem = (key: string) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  };
  const addItem = () => setItems((prev) => [...prev, newRow()]);

  const onSubmit = async () => {
    const clean = items
      .map((r) => ({
        material_id: r.material_id ?? '',
        quantity: Number(r.quantity),
      }))
      .filter((it) => it.material_id && !Number.isNaN(it.quantity));

    if (clean.length === 0) {
      toast.error('Cần ít nhất 1 dòng vật tư hợp lệ');
      return;
    }

    try {
      if (type === 'SET') {
        // SET: process each item with useSetMaterialStock
        for (const it of clean) {
          const m = materials.find((x) => x.id === it.material_id);
          await setStock.mutateAsync({
            material_id: it.material_id,
            target_quantity: it.quantity,
            current_quantity: Number(m?.on_hand ?? 0),
            reason: reason.trim() || `Kiểm kê ${date}`,
          });
        }
      } else {
        await createMut.mutateAsync({
          adjustment_date: date,
          type,
          reason: reason.trim() || null,
          items: clean.filter((it) => it.quantity > 0),
        });
      }
      onOpenChange(false);
    } catch {
      /* toast in hook */
    }
  };

  const isSubmitting = createMut.isPending || setStock.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo phiếu kiểm kê / điều chỉnh tồn</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Ngày kiểm kê</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Loại điều chỉnh</Label>
              <Select value={type} onValueChange={(v) => setType(v as AdjType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SET">SET — Đặt lại theo số kiểm đếm</SelectItem>
                  <SelectItem value="IN">IN — Nhập thêm (vd tìm thấy thừa)</SelectItem>
                  <SelectItem value="OUT">OUT — Xuất bớt (vd hỏng, mất)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>
                Vật tư cần điều chỉnh
                <span className="text-xs text-muted-foreground font-normal ml-2">
                  {type === 'SET'
                    ? '(nhập số tồn THỰC ĐẾM được)'
                    : type === 'IN'
                      ? '(số lượng cộng vào)'
                      : '(số lượng trừ ra)'}
                </span>
              </Label>
              <Button type="button" size="sm" variant="outline" onClick={addItem} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Thêm dòng
              </Button>
            </div>

            <div className="border rounded-md divide-y">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/40 text-xs font-medium text-muted-foreground">
                <div className="col-span-7">Vật tư</div>
                <div className="col-span-3 text-right">
                  {type === 'SET' ? 'Tồn mục tiêu' : 'Số lượng'}
                </div>
                <div className="col-span-2 text-right">
                  {type === 'SET' ? 'Delta' : ''}
                </div>
              </div>
              {items.map((r) => {
                const m = materials.find((x) => x.id === r.material_id);
                const cur = Number(m?.on_hand ?? 0);
                const target = Number(r.quantity);
                const delta = type === 'SET' ? (Number.isNaN(target) ? null : target - cur) : null;
                return (
                  <div key={r.key} className="grid grid-cols-12 gap-2 px-3 py-2 items-center">
                    <div className="col-span-7 flex items-center gap-2">
                      <div className="flex-1">
                        <MaterialPicker
                          value={r.material_id}
                          onChange={(id) => updateItem(r.key, { material_id: id })}
                          showStock
                        />
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-red-600 hover:text-red-700 shrink-0"
                        disabled={items.length === 1}
                        onClick={() => removeItem(r.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div className="col-span-3">
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={r.quantity}
                        onChange={(e) => updateItem(r.key, { quantity: e.target.value })}
                        className="text-right h-8"
                      />
                    </div>
                    <div className="col-span-2 text-right text-sm font-mono">
                      {delta !== null ? (
                        <span className={delta > 0 ? 'text-green-600' : delta < 0 ? 'text-red-600' : 'text-muted-foreground'}>
                          {delta > 0 ? '+' : ''}
                          {delta}
                        </span>
                      ) : (
                        ''
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label>Lý do</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ví dụ: Kiểm kê cuối tháng, phát hiện hỏng, tìm thấy thừa…"
            />
          </div>
        </div>

        <DialogFooter className="pt-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Huỷ
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Đang lưu…' : 'Tạo phiếu kiểm kê'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
