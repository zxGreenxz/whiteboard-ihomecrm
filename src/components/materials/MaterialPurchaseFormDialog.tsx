import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MaterialPicker } from '@/components/materials/MaterialPicker';
import {
  useCreateMaterialPurchase,
  useUpdateMaterialPurchase,
  type MaterialPurchaseWithItems,
} from '@/hooks/useMaterialPurchases';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { todayISO } from '@/lib/collect';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: MaterialPurchaseWithItems | null;
}

interface ItemRow {
  key: string;
  material_id: string | null;
  quantity: string;
  unit_price: string;
}

const newRow = (): ItemRow => ({
  key: crypto.randomUUID(),
  material_id: null,
  quantity: '',
  unit_price: '',
});

const NONE = '__none__';

function useSuppliersList() {
  return useQuery({
    queryKey: ['suppliers', 'simple'],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase
        .from('suppliers' as any)
        .select('id,name')
        .is('deleted_at', null)
        .order('name');
      if (error) return [];
      return (data ?? []) as unknown as { id: string; name: string }[];
    },
  });
}

export default function MaterialPurchaseFormDialog({ open, onOpenChange, editing }: Props) {
  const createMut = useCreateMaterialPurchase();
  const updateMut = useUpdateMaterialPurchase();
  const { data: suppliers = [] } = useSuppliersList();

  const [purchaseDate, setPurchaseDate] = useState(() => todayISO());
  const [supplierId, setSupplierId] = useState<string>(NONE);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<ItemRow[]>([newRow()]);

  const isEditing = !!editing;

  useEffect(() => {
    if (open) {
      if (editing) {
        setPurchaseDate(editing.purchase_date);
        setSupplierId(editing.supplier_id ?? NONE);
        setNotes(editing.notes ?? '');
        setItems(
          editing.items.map((it) => ({
            key: it.id,
            material_id: it.material_id,
            quantity: String(it.quantity),
            unit_price: String(it.unit_price),
          })),
        );
      } else {
        setPurchaseDate(todayISO());
        setSupplierId(NONE);
        setNotes('');
        setItems([newRow()]);
      }
    }
  }, [open, editing]);

  const total = items.reduce((sum, r) => {
    const q = Number(r.quantity) || 0;
    const p = Number(r.unit_price) || 0;
    return sum + q * p;
  }, 0);

  const updateItem = (key: string, patch: Partial<ItemRow>) => {
    setItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const removeItem = (key: string) => {
    setItems((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));
  };
  const addItem = () => setItems((prev) => [...prev, newRow()]);

  const onSubmit = async () => {
    const cleanItems = items
      .map((r) => ({
        material_id: r.material_id ?? '',
        quantity: Number(r.quantity) || 0,
        unit_price: Number(r.unit_price) || 0,
      }))
      .filter((it) => it.material_id && it.quantity > 0);

    if (cleanItems.length === 0) {
      toast.error('Cần ít nhất 1 dòng vật tư với số lượng > 0');
      return;
    }

    const payload = {
      purchase_date: purchaseDate,
      supplier_id: supplierId === NONE ? null : supplierId,
      notes: notes.trim() || null,
      items: cleanItems,
    };

    try {
      if (isEditing && editing) {
        await updateMut.mutateAsync({ id: editing.id, input: payload });
      } else {
        await createMut.mutateAsync(payload);
      }
      onOpenChange(false);
    } catch {
      /* toast in hook */
    }
  };

  const isSubmitting = createMut.isPending || updateMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? `Sửa phiếu nhập ${editing?.code}` : 'Thêm phiếu nhập kho'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Ngày nhập *</Label>
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Nhà cung cấp</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Không chọn" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— Không chọn —</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Vật tư nhập</Label>
              <Button type="button" size="sm" variant="outline" onClick={addItem} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Thêm dòng
              </Button>
            </div>

            <div className="border rounded-md divide-y">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-muted/40 text-xs font-medium text-muted-foreground">
                <div className="col-span-5">Vật tư</div>
                <div className="col-span-2 text-right">Số lượng</div>
                <div className="col-span-2 text-right">Đơn giá</div>
                <div className="col-span-2 text-right">Thành tiền</div>
                <div className="col-span-1" />
              </div>
              {items.map((r) => {
                const lineTotal = (Number(r.quantity) || 0) * (Number(r.unit_price) || 0);
                return (
                  <div key={r.key} className="grid grid-cols-12 gap-2 px-3 py-2 items-center">
                    <div className="col-span-5">
                      <MaterialPicker
                        value={r.material_id}
                        onChange={(id) => updateItem(r.key, { material_id: id })}
                        showStock
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={r.quantity}
                        onChange={(e) => updateItem(r.key, { quantity: e.target.value })}
                        className="text-right"
                      />
                    </div>
                    <div className="col-span-2">
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={r.unit_price}
                        onChange={(e) => updateItem(r.key, { unit_price: e.target.value })}
                        className="text-right"
                      />
                    </div>
                    <div className="col-span-2 text-right font-mono text-sm">
                      {lineTotal.toLocaleString('vi-VN')}
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-red-600 hover:text-red-700"
                        disabled={items.length === 1}
                        onClick={() => removeItem(r.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
              <div className="px-3 py-2 flex items-center justify-end gap-2 bg-muted/20 text-sm">
                <span className="text-muted-foreground">Tổng:</span>
                <span className="font-mono font-semibold">{total.toLocaleString('vi-VN')} đ</span>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Ghi chú</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Tuỳ chọn — ghi chú phiếu nhập"
            />
          </div>
        </div>

        <DialogFooter className="pt-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Huỷ
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting ? 'Đang lưu…' : isEditing ? 'Cập nhật' : 'Tạo phiếu nhập'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
