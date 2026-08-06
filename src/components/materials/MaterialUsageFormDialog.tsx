import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import MaterialUsageItemsEditor, {
  type UsageItemRow,
  newUsageItemRow,
} from '@/components/materials/MaterialUsageItemsEditor';
import { useCreateMaterialUsage } from '@/hooks/useMaterialUsages';
import { useMaterials } from '@/hooks/useMaterials';
import { toast } from 'sonner';
import { todayISO } from '@/lib/collect';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function MaterialUsageFormDialog({ open, onOpenChange }: Props) {
  const createMut = useCreateMaterialUsage();
  const { data: materials = [] } = useMaterials({});

  const [usageDate, setUsageDate] = useState(() => todayISO());
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<UsageItemRow[]>([newUsageItemRow()]);

  useEffect(() => {
    if (open) {
      setUsageDate(todayISO());
      setNotes('');
      setItems([newUsageItemRow()]);
    }
  }, [open]);

  const onSubmit = async () => {
    const cleanItems = items
      .map((r) => {
        const m = materials.find((x) => x.id === r.material_id);
        return {
          material_id: r.material_id ?? '',
          quantity: Number(r.quantity) || 0,
          unit_cost_at_usage: Number(m?.avg_unit_cost ?? 0),
        };
      })
      .filter((it) => it.material_id && it.quantity > 0);

    if (cleanItems.length === 0) {
      toast.error('Cần ít nhất 1 dòng vật tư với số lượng > 0');
      return;
    }

    try {
      await createMut.mutateAsync({
        usage_date: usageDate,
        notes: notes.trim() || null,
        items: cleanItems,
      });
      onOpenChange(false);
    } catch {
      /* toast in hook */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo phiếu xuất kho</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Ngày xuất *</Label>
            <Input type="date" value={usageDate} onChange={(e) => setUsageDate(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>Vật tư xuất</Label>
            <MaterialUsageItemsEditor items={items} onItemsChange={setItems} />
          </div>

          <div className="space-y-1">
            <Label>Ghi chú</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Tuỳ chọn — lý do xuất kho (không gắn phiếu công việc)"
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            Khi lưu, tồn kho sẽ tự động trừ. Giá vốn snapshot tại thời điểm xuất.
            Người tạo &amp; thời điểm được ghi nhận tự động.
          </p>
        </div>

        <DialogFooter className="pt-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMut.isPending}
          >
            Huỷ
          </Button>
          <Button type="button" onClick={onSubmit} disabled={createMut.isPending}>
            {createMut.isPending ? 'Đang lưu…' : 'Tạo phiếu xuất'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
