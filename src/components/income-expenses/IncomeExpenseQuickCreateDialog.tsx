import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  useIncomeExpenseFormBuildings,
  useIncomeExpenseFormRooms,
} from "@/hooks/useIncomeExpenseFormScope";
import { useAccounts } from "@/hooks/useAccounts";
import {
  useIncomeExpenseTypes,
  useCreateIncomeExpenseType,
} from "@/hooks/useIncomeExpenseTypes";
import { useCreateIncomeExpense } from "@/hooks/useIncomeExpenses";
import { normalizeLoose } from "@/lib/textMatch";
import {
  parseIncomeExpenseQuickInput,
  countTokens,
  type BuildingRef,
  type RoomRef,
  type IeTypeRef,
} from "@/lib/incomeExpenseQuickInput";
import QuickCategoryInput from "./QuickCategoryInput";
import CategoryCombobox from "@/components/income-expense-types/CategoryCombobox";
import { todayISO } from '@/lib/collect';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType?: "INCOME" | "EXPENSE";
  onSaved?: () => void;
}

const fmtVND = (n: number) => new Intl.NumberFormat("vi-VN").format(n);
const today = () => todayISO();

const IncomeExpenseQuickCreateDialog = ({
  open,
  onOpenChange,
  defaultType,
  onSaved,
}: Props) => {
  const isMobile = useIsMobile();

  const [raw, setRaw] = useState("");
  const [mode, setMode] = useState<"INCOME" | "EXPENSE">(
    defaultType ?? "EXPENSE",
  );
  const [lockedTypeId, setLockedTypeId] = useState<string | null>(null);
  const [categoryEndIndex, setCategoryEndIndex] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [accountTouched, setAccountTouched] = useState(false);
  // Bước phụ "Tạo hạng mục mới" (bắt buộc chọn Nhóm).
  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const [newCategory, setNewCategory] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const caretToEndRef = useRef(false);

  const { data: buildings = [] } = useIncomeExpenseFormBuildings();
  const { data: allRooms = [] } = useIncomeExpenseFormRooms(undefined, { allWhenEmpty: true });
  const { data: accounts = [] } = useAccounts();
  const modeLower = mode === "INCOME" ? "income" : "expense";
  const { data: typeRows = [] } = useIncomeExpenseTypes(modeLower);
  const createIE = useCreateIncomeExpense();
  const createType = useCreateIncomeExpenseType();

  const buildingRefs = useMemo<BuildingRef[]>(
    () => buildings.map((b: any) => ({ id: b.id, name: b.name, code: b.code })),
    [buildings],
  );
  const roomRefs = useMemo<RoomRef[]>(
    () =>
      allRooms.map((r: any) => ({
        id: r.id,
        name: r.name,
        code: r.code ?? null,
        building_id: r.building_id,
      })),
    [allRooms],
  );
  const types = useMemo<IeTypeRef[]>(
    () =>
      typeRows.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        type: t.type,
      })),
    [typeRows],
  );

  const parsed = useMemo(
    () =>
      parseIncomeExpenseQuickInput({
        raw,
        buildings: buildingRefs,
        rooms: roomRefs,
        types,
        lockedTypeId,
        categoryEndIndex,
      }),
    [raw, buildingRefs, roomRefs, types, lockedTypeId, categoryEndIndex],
  );

  // Gợi ý hạng mục: lọc theo categorySearch, xếp hạng startsWith > includes > nhóm.
  const suggestions = useMemo<IeTypeRef[]>(() => {
    if (parsed.categoryLocked || parsed.categorySearch == null) return [];
    const q = normalizeLoose(parsed.categorySearch);
    if (!q) return types.slice(0, 8);
    return types
      .map((t) => {
        const n = normalizeLoose(t.name);
        const cat = normalizeLoose(t.category ?? "");
        let score = -1;
        if (n.startsWith(q)) score = 0;
        else if (n.includes(q)) score = 1;
        else if (cat.includes(q)) score = 2;
        return { t, score };
      })
      .filter((x) => x.score >= 0)
      .sort(
        (a, b) =>
          a.score - b.score ||
          a.t.name.localeCompare(b.t.name, "vi", { sensitivity: "base" }),
      )
      .slice(0, 8)
      .map((x) => x.t);
  }, [types, parsed.categorySearch, parsed.categoryLocked]);

  // Reset khi mở
  useEffect(() => {
    if (open) {
      setRaw("");
      setMode(defaultType ?? "EXPENSE");
      setLockedTypeId(null);
      setCategoryEndIndex(null);
      setAccountId("");
      setAccountTouched(false);
      setCreating(null);
      setNewCategory(null);
    }
  }, [open, defaultType]);

  // Tự chọn sổ quỹ theo tòa nhà (đến khi user tự đổi).
  useEffect(() => {
    if (!open || accountTouched || accounts.length === 0) return;
    const bid = parsed.buildingId;
    const byBuilding = bid
      ? accounts.find((a) => a.quick_default_building_id === bid)
      : undefined;
    const fallback = accounts.find((a) => a.is_default) ?? accounts[0];
    setAccountId((byBuilding ?? fallback)?.id ?? "");
  }, [open, accountTouched, accounts, parsed.buildingId]);

  // Đưa con trỏ về cuối sau khi ghi đè input (chọn hạng mục).
  useEffect(() => {
    if (caretToEndRef.current && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
      caretToEndRef.current = false;
    }
  }, [raw]);

  const handleSelectCategory = (type: IeTypeRef) => {
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    const room = tokens[0] ?? "";
    const building = tokens[1] ?? "";
    setLockedTypeId(type.id);
    setCategoryEndIndex(2 + countTokens(type.name));
    caretToEndRef.current = true;
    setRaw(`${room} ${building} ${type.name} `);
  };

  const handleModeChange = (next: "INCOME" | "EXPENSE") => {
    if (next === mode) return;
    setMode(next);
    setLockedTypeId(null);
    setCategoryEndIndex(null);
    setCreating(null);
    setNewCategory(null);
  };

  const handleCreateNew = (query: string) => {
    setCreating({ name: query });
    setNewCategory(null);
  };

  const handleConfirmCreate = async () => {
    const cat = newCategory?.trim();
    if (!creating || !cat) return;
    try {
      const created: any = await createType.mutateAsync({
        name: creating.name,
        type: modeLower,
        category: cat,
      });
      setCreating(null);
      setNewCategory(null);
      handleSelectCategory({
        id: created.id,
        name: created.name ?? creating.name,
        category: cat,
        type: modeLower,
      });
    } catch {
      // toast handled by hook
    }
  };

  const canSubmit =
    !!parsed.buildingId &&
    (!!parsed.roomId || parsed.isBuildingWide) &&
    !!parsed.typeId &&
    parsed.amount != null &&
    !!accountId &&
    !createIE.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const d = today();
    const note = parsed.noteText.trim();
    const name = note || parsed.typeName || raw.trim();
    try {
      await createIE.mutateAsync({
        type: mode,
        name,
        building_id: parsed.buildingId!,
        room_id: parsed.roomId ?? null,
        tenant_id: null,
        contract_id: null,
        payer_name: null,
        account_id: accountId,
        voucher_date: d,
        business_result_accounting: null,
        repeat_cycle: "NONE",
        repeat_infinity: false,
        repeat_count: 0,
        attachments: [],
        items: [
          {
            income_expense_type_id: parsed.typeId!,
            description: note || null,
            quantity: 1,
            unit_price: parsed.amount!,
            start_date: d,
            end_date: d,
          },
        ],
      });
      onOpenChange(false);
      onSaved?.();
    } catch {
      // toast handled by hook
    }
  };

  const amountDigits = (parsed.amountToken ?? "").replace(/\D/g, "");
  const amountLooksBig = parsed.amount != null && amountDigits.length >= 6;

  const formBody = (
    <>
      {/* Dòng 1: Thu / Chi */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => handleModeChange("INCOME")}
          className={cn(
            "h-11 rounded-md border font-medium flex items-center justify-center gap-1.5 transition-colors",
            mode === "INCOME"
              ? "bg-emerald-500 text-white border-emerald-500"
              : "bg-background text-foreground hover:bg-accent",
          )}
        >
          <ArrowUp className="h-4 w-4" /> Thu
        </button>
        <button
          type="button"
          onClick={() => handleModeChange("EXPENSE")}
          className={cn(
            "h-11 rounded-md border font-medium flex items-center justify-center gap-1.5 transition-colors",
            mode === "EXPENSE"
              ? "bg-red-500 text-white border-red-500"
              : "bg-background text-foreground hover:bg-accent",
          )}
        >
          <ArrowDown className="h-4 w-4" /> Chi
        </button>
      </div>

      {/* Dòng 2: mô tả nhanh */}
      <div className="space-y-1">
        <label className="text-[13px] font-medium block">
          Mô tả nhanh <span className="text-red-500">*</span>
        </label>
        <QuickCategoryInput
          value={raw}
          onChange={setRaw}
          active={
            !parsed.categoryLocked && parsed.categorySearch != null && !creating
          }
          query={parsed.categorySearch ?? ""}
          suggestions={suggestions}
          lockedTypeId={lockedTypeId}
          onSelect={handleSelectCategory}
          onCreateNew={handleCreateNew}
          inputRef={inputRef}
          autoFocus
          placeholder="201 1392qt tiền điện tháng 5 200"
        />
        <p className="text-[11px] text-muted-foreground leading-tight">
          Cú pháp: <code>(phòng) (tòa) (hạng mục) (ghi chú) (số tiền)</code>. Gõ
          hạng mục để hiện gợi ý, <b>chọn 1 mục</b>. Số tiền:{" "}
          <code>200</code> hoặc <code>200k</code> = 200.000. Phòng ={" "}
          <code>tn</code> nếu cho cả tòa.
        </p>
      </div>

      {/* Bước tạo hạng mục mới */}
      {creating && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
          <div className="text-[13px] font-medium">
            Tạo hạng mục mới:{" "}
            <span className="text-primary">{creating.name}</span>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-muted-foreground">
              Nhóm Thu/Chi <span className="text-red-500">*</span> (bắt buộc để
              thống kê)
            </label>
            <CategoryCombobox
              value={newCategory}
              onChange={setNewCategory}
              filterType={modeLower}
              placeholder="Chọn hoặc gõ tên nhóm mới…"
            />
          </div>
          <div className="flex justify-end gap-2 pt-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setCreating(null);
                setNewCategory(null);
              }}
            >
              Huỷ
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!newCategory?.trim() || createType.isPending}
              onClick={handleConfirmCreate}
            >
              {createType.isPending ? "Đang tạo…" : "Tạo & chọn"}
            </Button>
          </div>
        </div>
      )}

      {/* Sổ quỹ */}
      <div className="space-y-1">
        <label className="text-[13px] font-medium block">
          Sổ quỹ <span className="text-red-500">*</span>
        </label>
        <Select
          value={accountId || undefined}
          onValueChange={(v) => {
            setAccountId(v);
            setAccountTouched(true);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Chọn sổ quỹ" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Preview */}
      {raw.trim().length > 0 && (
        <div className="rounded-md border bg-muted/30 p-2.5 space-y-1.5 text-[13px]">
          {parsed.errors.structure ? (
            <div className="flex items-start gap-2 text-red-600">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{parsed.errors.structure}</span>
            </div>
          ) : (
            <>
              <PreviewRow
                label="Phòng"
                ok={!!parsed.roomId || parsed.isBuildingWide}
                value={
                  parsed.isBuildingWide
                    ? "Toàn tòa nhà (không phòng)"
                    : parsed.roomToken || "(chưa có)"
                }
                error={parsed.errors.roomNotFound}
              />
              <PreviewRow
                label="Tòa nhà"
                ok={!!parsed.buildingId}
                value={parsed.buildingToken || "(chưa có)"}
                error={parsed.errors.buildingNotFound}
              />
              <PreviewRow
                label="Hạng mục"
                ok={!!parsed.typeId}
                value={
                  parsed.typeName ||
                  (parsed.categorySearch?.trim()
                    ? `${parsed.categorySearch.trim()} (chọn từ gợi ý)`
                    : "(chưa chọn)")
                }
                error={!parsed.typeId ? parsed.errors.categoryMissing : undefined}
              />
              <PreviewRow
                label="Ghi chú"
                ok
                value={parsed.noteText.trim() || "(không)"}
              />
              <PreviewRow
                label="Số tiền"
                ok={parsed.amount != null}
                value={
                  parsed.amount != null
                    ? `${parsed.amountToken} → ${fmtVND(parsed.amount)}đ`
                    : "(thiếu)"
                }
                error={parsed.amount == null ? parsed.errors.amountMissing : undefined}
              />
              {amountLooksBig && (
                <div className="flex items-start gap-2 text-amber-600">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    Số tiền lớn — nhớ quy ước nhập nhanh luôn ×1000 (vd 200 =
                    200.000). Kiểm tra lại nếu cần.
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );

  const footer = (
    <>
      <Button
        type="button"
        className={cn(
          "text-white w-full h-11",
          mode === "INCOME"
            ? "bg-emerald-600 hover:bg-emerald-700"
            : "bg-red-600 hover:bg-red-700",
        )}
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        {createIE.isPending
          ? "Đang lưu..."
          : `Lưu phiếu ${mode === "INCOME" ? "thu" : "chi"}`}
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
        className="w-full h-11"
      >
        Huỷ
      </Button>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-[100dvh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none flex flex-col p-0 gap-0 data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
            : "sm:max-w-[560px] max-h-[90vh] overflow-y-auto"
        }
      >
        {isMobile ? (
          <>
            <div className="shrink-0 pt-2 pb-1 flex justify-center">
              <div className="w-10 h-1 bg-zinc-300 rounded-full" />
            </div>
            <DialogHeader className="shrink-0 px-4 pb-2.5 border-b">
              <DialogTitle className="uppercase font-semibold text-base">
                Tạo phiếu nhanh
              </DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {formBody}
            </div>
            <DialogFooter className="shrink-0 px-4 py-3 border-t flex flex-col gap-2 bg-background">
              {footer}
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="uppercase font-semibold">
                Tạo phiếu nhanh
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">{formBody}</div>
            <DialogFooter className="flex flex-col gap-2 sm:flex-col">
              {footer}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

function PreviewRow({
  label,
  ok,
  value,
  error,
}: {
  label: string;
  ok: boolean;
  value: string;
  error?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-green-600" />
      ) : (
        <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center flex-wrap">
          <span className="text-muted-foreground mr-2">{label}:</span>
          <span className={ok ? "font-medium" : "font-medium text-red-600"}>
            {value}
          </span>
        </div>
        {error && <p className="text-xs text-red-600 mt-0.5">{error}</p>}
      </div>
    </div>
  );
}

export default IncomeExpenseQuickCreateDialog;
