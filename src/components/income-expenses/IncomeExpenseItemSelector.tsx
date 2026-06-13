import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  useIncomeExpenseTypes,
  type IncomeExpenseType,
} from '@/hooks/useIncomeExpenseTypes';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import IncomeExpenseTypeForm from '@/components/income-expense-types/IncomeExpenseTypeForm';
import EditIncomeExpenseTypeDialog from '@/components/income-expense-types/EditIncomeExpenseTypeDialog';

interface IncomeExpenseItemSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  voucherType: 'INCOME' | 'EXPENSE';
  onSelect: (types: IncomeExpenseType[]) => void;
  selectedTypeIds: string[];
}

const IncomeExpenseItemSelector = ({
  open,
  onOpenChange,
  voucherType,
  onSelect,
  selectedTypeIds,
}: IncomeExpenseItemSelectorProps) => {
  const filterType = voucherType === 'INCOME' ? 'income' : 'expense';
  const { data: types = [], isLoading } = useIncomeExpenseTypes(filterType);
  const { data: perms } = useMyPermissions();
  const canPickRestricted = canUse(perms, 'income_expenses', 'restricted_create');
  // Ẩn hạng mục "hạn chế" khỏi danh sách CHỌN nếu không có quyền tạo (A). Vẫn giữ
  // những hạng mục đã được chọn sẵn (edit) vì handleConfirm map trên `types` đầy đủ.
  const visibleTypes = canPickRestricted
    ? types
    : types.filter((t) => !t.is_restricted);

  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [isTypeFormOpen, setIsTypeFormOpen] = useState(false);
  const [editingType, setEditingType] = useState<IncomeExpenseType | null>(
    null
  );

  // Sync checkedIds with selectedTypeIds when dialog opens
  useEffect(() => {
    if (open) {
      setCheckedIds(new Set(selectedTypeIds));
      setIsTypeFormOpen(false);
    }
  }, [open, selectedTypeIds]);

  const handleToggle = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selected = types.filter((t) => checkedIds.has(t.id));
    onSelect(selected);
    onOpenChange(false);
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleTypeCreated = (newType: IncomeExpenseType) => {
    // Auto-add newly created type to selection
    setCheckedIds((prev) => new Set([...prev, newType.id]));
    setIsTypeFormOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            Chọn hạng mục {voucherType === 'INCOME' ? 'thu' : 'chi'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Type list with checkboxes */}
          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {isLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Đang tải...
              </p>
            ) : visibleTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Chưa có loại {voucherType === 'INCOME' ? 'thu' : 'chi'} nào.
                Hãy thêm mới.
              </p>
            ) : (
              visibleTypes.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-3 rounded-lg border p-3 hover:bg-accent"
                >
                  <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                    <Checkbox
                      checked={checkedIds.has(t.id)}
                      onCheckedChange={() => handleToggle(t.id)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{t.name}</p>
                    </div>
                  </label>
                  <button
                    type="button"
                    aria-label={`Sửa hạng mục ${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingType(t);
                    }}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Inline collapsible form to create new type */}
          <Collapsible open={isTypeFormOpen} onOpenChange={setIsTypeFormOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
              >
                <Plus className="h-4 w-4 mr-1" />
                Thêm loại {voucherType === 'INCOME' ? 'thu' : 'chi'} mới
                {isTypeFormOpen ? (
                  <ChevronUp className="h-4 w-4 ml-auto" />
                ) : (
                  <ChevronDown className="h-4 w-4 ml-auto" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 rounded-lg border p-4 bg-muted/30">
                <IncomeExpenseTypeForm
                  defaultType={filterType}
                  onCreated={handleTypeCreated}
                  onCancel={() => setIsTypeFormOpen(false)}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Action buttons */}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={handleCancel}>
              Huỷ
            </Button>
            <Button type="button" onClick={handleConfirm}>
              Xác nhận
            </Button>
          </div>
        </div>
      </DialogContent>

      <EditIncomeExpenseTypeDialog
        open={!!editingType}
        onOpenChange={(o) => {
          if (!o) setEditingType(null);
        }}
        type={editingType}
        onDeleted={(deletedId) => {
          setCheckedIds((prev) => {
            if (!prev.has(deletedId)) return prev;
            const next = new Set(prev);
            next.delete(deletedId);
            return next;
          });
        }}
      />
    </Dialog>
  );
};

export default IncomeExpenseItemSelector;
