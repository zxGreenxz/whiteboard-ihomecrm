import { useEffect, useState, useRef } from 'react';
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
import { validateMaterialUsageRows } from '@/lib/materialUsageValidation';
import { focusFirstError } from '@/lib/formErrors';
import { materialVoucherFailureMessage, materialVoucherRetryBlocked } from '@/lib/materialVoucherOutcome';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { validateInputDrafts } from '@/lib/inputDraftValidation';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function MaterialUsageFormDialog({ open, onOpenChange }: Props) {
  const root=useRef<HTMLDivElement|null>(null);
  const createMut = useCreateMaterialUsage();
  const materialsQuery = useMaterials({});
  const materials = materialsQuery.data ?? [];

  const [usageDate, setUsageDate] = useState(() => todayISO());
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<UsageItemRow[]>([newUsageItemRow()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rootError, setRootError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && !rootError && !blocked) {
      setUsageDate(todayISO());
      setNotes('');
      setItems([newUsageItemRow()]);
      setErrors({});
    }
  }, [open]);

  const onSubmit = async () => {
    if(!validateInputDrafts(root.current))return;
    if (blocked || saving || createMut.isPending) return;
    if (materialsQuery.isPending || materialsQuery.isError) {
      toast.error('Chưa tải được danh sách vật tư. Tải lại trước khi tạo phiếu xuất.');
      return;
    }
    const rowErrors = validateMaterialUsageRows(items);
    for (const [index, row] of items.entries()) {
      if (row.material_id && !materials.some(material => material.id === row.material_id)) {
        rowErrors[`materials.${index}.material_id`] = 'Vật tư này không còn trong danh sách. Chọn lại vật tư.';
      }
    }
    if (!usageDate) rowErrors.usage_date = 'Chọn ngày xuất kho.';
    if (Object.keys(rowErrors).length > 0) {
      setErrors(rowErrors);
      toast.error('Kiểm tra các ô được đánh dấu đỏ trước khi tạo phiếu xuất.');
      void focusFirstError(rowErrors, { root: document.querySelector<HTMLElement>('[role="dialog"]'),
        order: ['usage_date', 'materials'] });
      return;
    }
    setErrors({});
    setRootError('');
    setSaving(true);
    const cleanItems = items
      .map((r) => {
        const m = materials.find((x) => x.id === r.material_id);
        return {
          material_id: r.material_id ?? '',
          quantity: Number(r.quantity) || 0,
          unit_cost_at_usage: Number(m?.avg_unit_cost ?? 0),
        };
      });

    try {
      await createMut.mutateAsync({
        usage_date: usageDate,
        notes: notes.trim() || null,
        items: cleanItems,
      });
      onOpenChange(false);
    } catch (error) {
      const ids = error instanceof FinancialWorkflowError ? error.completed.map(step => step.id) : [];
      setRootError(materialVoucherFailureMessage(error, 'tạo phiếu xuất') + (ids.length ? ` ID cần đối chiếu: ${ids.join(', ')}.` : ''));
      setBlocked(materialVoucherRetryBlocked(error));
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving && !createMut.isPending) onOpenChange(next); }}>
      <DialogContent ref={root} aria-describedby={undefined} className="sm:max-w-[640px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo phiếu xuất kho</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {rootError && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{rootError}</p>}
          {materialsQuery.isError && <Button type="button" variant="outline" onClick={() => void materialsQuery.refetch()}>Tải lại vật tư</Button>}
          <fieldset disabled={saving || createMut.isPending || blocked} className="space-y-4">
          <div className="space-y-1">
            <Label>Ngày xuất *</Label>
            <Input type="date" data-field-name="usage_date" aria-invalid={!!errors.usage_date}
              value={usageDate} onChange={(e) => { setUsageDate(e.target.value); setErrors(previous => ({ ...previous, usage_date: '' })); }} />
            {errors.usage_date && <p role="alert" className="text-xs text-destructive">{errors.usage_date}</p>}
          </div>

          <div className="space-y-2">
            <Label>Vật tư xuất</Label>
            <MaterialUsageItemsEditor items={items} errors={errors}
              onItemsChange={next => { setItems(next); setErrors({}); }} />
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
          </fieldset>
        </div>

        <DialogFooter className="pt-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving || createMut.isPending}
          >
            {blocked ? 'Đóng để đối chiếu' : 'Huỷ'}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={saving || createMut.isPending || blocked || materialsQuery.isPending || materialsQuery.isError}>
            {createMut.isPending ? 'Đang lưu…' : 'Tạo phiếu xuất'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
