import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Plus, ChevronDown, ChevronUp, Pencil, Search, X } from 'lucide-react';
import { normalizeLoose } from '@/lib/textMatch';
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
import { useCanManageIeTypes } from '@/hooks/useCanManageIeTypes';
import { canUse } from '@/lib/permissionPages';
import { pickableIeTypes, sortIeTypesForPicker } from '@/lib/ieTypeCatalog';
import { groupIeTypesForPicker, ieTypeMatchesQuery } from '@/lib/ieTypeLookup';
import IncomeExpenseTypeForm from '@/components/income-expense-types/IncomeExpenseTypeForm';
import EditIncomeExpenseTypeDialog from '@/components/income-expense-types/EditIncomeExpenseTypeDialog';
import { LoadingState } from '@/components/loading/LoadingState';

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
  // Thêm / sửa / xoá hạng mục: chỉ superadmin / chủ công ty (chủ duyệt 03/10/2026).
  const { canManage, isLoading: manageLoading } = useCanManageIeTypes();
  // Danh mục chi chuẩn: chỉ mục chọn được (không lưu trữ, không system_only, không ẩn lập
  // tay; mục hạn chế cần restricted_create). Mục đang gắn sẵn trên phiếu (sửa phiếu cũ) vẫn
  // hiện dù đã lưu trữ; handleConfirm map trên `types` đầy đủ nên không rơi lựa chọn cũ.
  const selectedKey = selectedTypeIds.join('|');
  const visibleTypes = useMemo(
    () =>
      sortIeTypesForPicker(
        pickableIeTypes(types, {
          canPickRestricted,
          keepIds: selectedKey ? selectedKey.split('|') : [],
        })
      ),
    [types, canPickRestricted, selectedKey]
  );

  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [isTypeFormOpen, setIsTypeFormOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editingType, setEditingType] = useState<IncomeExpenseType | null>(
    null
  );

  // Lọc nhanh theo tên hoặc cụm từ hay nói, bỏ dấu + không phân biệt hoa/thường.
  // Ô tìm trống ⇒ hiện theo nhóm của danh mục.
  const normalizedQuery = normalizeLoose(query);
  const filteredTypes = normalizedQuery
    ? visibleTypes.filter((t) => ieTypeMatchesQuery(t, query))
    : visibleTypes;
  const groups = normalizedQuery ? null : groupIeTypesForPicker(visibleTypes);

  // Sync checkedIds with selectedTypeIds when dialog opens
  useEffect(() => {
    if (open) {
      setCheckedIds(new Set(selectedTypeIds));
      setIsTypeFormOpen(false);
      setQuery('');
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

  const renderTypeRow = (t: IncomeExpenseType) => (
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
          {t.archived_at && (
            <p className="text-xs text-muted-foreground">
              Đã lưu trữ — chỉ giữ cho phiếu cũ
            </p>
          )}
        </div>
      </label>
      {canManage && (
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
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            Chọn hạng mục {voucherType === 'INCOME' ? 'thu' : 'chi'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Ô lọc nhanh hạng mục theo tên */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Tìm hạng mục ${voucherType === 'INCOME' ? 'thu' : 'chi'}...`}
              className="pl-9 pr-9"
              aria-label="Tìm hạng mục"
            />
            {query && (
              <button
                type="button"
                aria-label="Xoá tìm kiếm"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Type list with checkboxes */}
          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {isLoading ? (
              <LoadingState label={`hạng mục ${voucherType === 'INCOME' ? 'thu' : 'chi'}`} rows={5} />
            ) :visibleTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Chưa có loại {voucherType === 'INCOME' ? 'thu' : 'chi'} nào.
                {canManage ? ' Hãy thêm mới.' : ' Báo chủ công ty thêm.'}
              </p>
            ) : filteredTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Không tìm thấy hạng mục khớp với "{query}".
              </p>
            ) : groups ? (
              groups.map((g) => (
                <div key={g.label} role="group" aria-label={g.label} className="space-y-2">
                  <p className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {g.label}
                  </p>
                  {g.items.map(renderTypeRow)}
                </div>
              ))
            ) : (
              filteredTypes.map(renderTypeRow)
            )}
          </div>

          {/* Inline collapsible form to create new type — chỉ superadmin / chủ công ty */}
          {canManage ? (
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
          ) : !manageLoading && (
            <p className="text-xs text-muted-foreground text-center">
              Cần hạng mục mới? Báo chủ công ty thêm.
            </p>
          )}

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

      {canManage && (
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
      )}
    </Dialog>
  );
};

export default IncomeExpenseItemSelector;
