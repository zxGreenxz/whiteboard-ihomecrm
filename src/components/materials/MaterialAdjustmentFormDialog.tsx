import { useEffect, useState, useRef } from 'react';
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
import { todayISO } from '@/lib/collect';
import { focusFirstError } from '@/lib/formErrors';
import { materialVoucherFailureMessage, materialVoucherRetryBlocked } from '@/lib/materialVoucherOutcome';
import { FinancialWorkflowError } from '@/lib/financialWorkflow';
import { validateInputDrafts } from '@/lib/inputDraftValidation';
import { persistentFinancialWorkflow } from '@/lib/persistentFinancialWorkflow';

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
  const root=useRef<HTMLDivElement|null>(null);
  const createMut = useCreateMaterialAdjustment();
  const setStock = useSetMaterialStock({ silent: true });
  const materialsQuery = useMaterials({});
  const materials = materialsQuery.data ?? [];
  const [batchGuard] = useState(() => persistentFinancialWorkflow('material-adjustment-batch'));

  const [type, setType] = useState<AdjType>('SET');
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<ItemRow[]>([newRow()]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [rootError, setRootError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && !rootError && !blocked) {
      setType('SET');
      setDate(todayISO());
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
    if(!validateInputDrafts(root.current))return;
    if (blocked || saving || createMut.isPending || setStock.isPending) return;
    const rowErrors: Record<string, string> = {};
    const seen = new Set<string>();
    items.forEach((row, index) => {
      const key = `materials.${index}`;
      if (!row.material_id || !materials.some(material => material.id === row.material_id)) rowErrors[`${key}.material_id`] = 'Chọn vật tư có trong danh sách.';
      else if (seen.has(row.material_id)) rowErrors[`${key}.material_id`] = 'Vật tư đã có trong dòng trước. Sửa số lượng tại dòng đó.';
      if (row.material_id) seen.add(row.material_id);
      const quantity = Number(row.quantity);
      if (!row.quantity.trim() || !Number.isFinite(quantity) || quantity < 0 || (type !== 'SET' && quantity === 0)) rowErrors[`${key}.quantity`] = type === 'SET' ? 'Nhập số kiểm đếm không âm.' : 'Nhập số lượng lớn hơn 0.';
    });
    if (!date) rowErrors.adjustment_date = 'Chọn ngày kiểm kê.';
    if (Object.keys(rowErrors).length) { setErrors(rowErrors); void focusFirstError(rowErrors, { root: document.querySelector<HTMLElement>('[role="dialog"]'), order: ['adjustment_date', 'materials'] }); return; }
    if (materialsQuery.isPending || materialsQuery.isError) { setRootError('Chưa tải được tồn kho. Tải lại vật tư trước khi điều chỉnh.'); return; }
    setErrors({}); setRootError(''); setSaving(true);
    const clean = items.map(row => ({ material_id: row.material_id!, quantity: Number(row.quantity) }));
    try {
      if (type === 'SET') {
        const changed = await batchGuard.run('create', 'kiểm kê nhiều vật tư', async progress => {
          let count = 0;
          for (const [index, row] of clean.entries()) {
            progress.stage = `điều chỉnh vật tư dòng ${index + 1}`;
            try {
              const material = materials.find(item => item.id === row.material_id)!;
              if (!Number.isFinite(Number(material.on_hand))) throw new Error('Chưa xác nhận được tồn kho hiện tại.');
              const result = await setStock.mutateAsync({ material_id: row.material_id, target_quantity: row.quantity, current_quantity: Number(material.on_hand), reason: reason.trim() || `Kiểm kê ${date}` });
              if (result) { count++; progress.completed.push({ id: result.id, label: `Phiếu kiểm kê ID ${result.id} đã lưu` }); }
            } catch (error) {
              if (error instanceof FinancialWorkflowError) progress.completed.push(...error.completed.filter(step => !progress.completed.some(previous => previous.id === step.id)));
              if (progress.completed.length) throw new FinancialWorkflowError(`Kiểm kê mới hoàn tất một phần. ID phiếu đã nhận: ${progress.completed.map(step => step.id).join(', ')}. Đối chiếu các phiếu và tồn kho trước khi thực hiện tiếp.`, 'partial', [...progress.completed], error);
              throw error;
            }
          }
          return count;
        });
        if (changed) toast.success(`Đã lưu ${changed} phiếu kiểm kê.`); else toast.info('Tồn đã khớp — không cần điều chỉnh');
      } else {
        await createMut.mutateAsync({ adjustment_date: date, type, reason: reason.trim() || null, items: clean });
      }
      onOpenChange(false);
    } catch (error) {
      const ids = error instanceof FinancialWorkflowError ? error.completed.map(step => step.id) : [];
      setRootError(materialVoucherFailureMessage(error, 'kiểm kê vật tư') + (ids.length ? ` ID cần đối chiếu: ${ids.join(', ')}.` : ''));
      setBlocked(materialVoucherRetryBlocked(error));
      if (type === 'SET') toast.error('Chưa hoàn tất kiểm kê vật tư', { description: materialVoucherFailureMessage(error, 'kiểm kê vật tư') });
    } finally { setSaving(false); }
  };
  const isSubmitting = saving || createMut.isPending || setStock.isPending;
  return (
    <Dialog open={open} onOpenChange={next => { if (!isSubmitting) onOpenChange(next); }}>
      <DialogContent ref={root} aria-describedby={undefined} className="sm:max-w-[640px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tạo phiếu kiểm kê / điều chỉnh tồn</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {rootError && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{rootError}</p>}
          {materialsQuery.isError && <Button type="button" variant="outline" onClick={() => void materialsQuery.refetch()}>Tải lại vật tư</Button>}
          <fieldset disabled={isSubmitting || blocked} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Ngày kiểm kê</Label>
              <Input data-field-name="adjustment_date" aria-invalid={!!errors.adjustment_date} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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

          {errors.adjustment_date && <p role="alert" className="text-xs text-destructive">{errors.adjustment_date}</p>}
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
              {items.map((r, index) => {
                const m = materials.find((x) => x.id === r.material_id);
                const cur = Number(m?.on_hand ?? 0);
                const target = Number(r.quantity);
                const delta = type === 'SET' ? (Number.isNaN(target) ? null : target - cur) : null;
                return (
                  <div key={r.key} className="grid grid-cols-12 gap-2 px-3 py-2 items-center">
                    <div className="col-span-7 flex items-center gap-2">
                      <div className="flex-1" data-field-name={`materials.${index}.material_id`}>
                        <MaterialPicker
                          value={r.material_id}
                          onChange={(id) => updateItem(r.key, { material_id: id })}
                          invalid={!!errors[`materials.${index}.material_id`]}
                        showStock
                      />
                      {errors[`materials.${index}.material_id`] && <p role="alert" className="text-xs text-destructive">{errors[`materials.${index}.material_id`]}</p>}
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
                        data-field-name={`materials.${index}.quantity`} aria-invalid={!!errors[`materials.${index}.quantity`]} value={r.quantity}
                        onChange={(e) => updateItem(r.key, { quantity: e.target.value })}
                        className="text-right h-8"
                      />
                      {errors[`materials.${index}.quantity`] && <p role="alert" className="text-xs text-destructive">{errors[`materials.${index}.quantity`]}</p>}
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
          </fieldset>
        </div>

        <DialogFooter className="pt-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {blocked ? 'Đóng để đối chiếu' : 'Huỷ'}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isSubmitting || blocked || materialsQuery.isPending || materialsQuery.isError}>
            {isSubmitting ? 'Đang lưu…' : 'Tạo phiếu kiểm kê'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
