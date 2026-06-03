import { X } from "lucide-react";
import type { IncomeExpenseFilters } from "@/hooks/useIncomeExpenses";
import { useAreas } from "@/hooks/useAreas";
import { useBuildings } from "@/hooks/useBuildings";
import { useAccounts } from "@/hooks/useAccounts";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useStaffUsers } from "@/hooks/useStaffUsers";
import { format } from "date-fns";

interface Props {
  filters: IncomeExpenseFilters;
  emptyFilters: IncomeExpenseFilters;
  onChange: (next: IncomeExpenseFilters) => void;
}

interface Chip {
  key: keyof IncomeExpenseFilters;
  label: string;
  patch: Partial<IncomeExpenseFilters>;
}

export function IncomeExpenseFilterChips({
  filters,
  emptyFilters,
  onChange,
}: Props) {
  const { data: areas } = useAreas();
  const { data: buildings } = useBuildings({ includeVirtual: true });
  const { data: accounts } = useAccounts();
  const { data: incomeTypes } = useIncomeExpenseTypes("income");
  const { data: expenseTypes } = useIncomeExpenseTypes("expense");
  const { data: staffUsers } = useStaffUsers();

  const chips: Chip[] = [];

  // Trạng thái — chỉ hiển thị nếu khác mặc định "ALL_ACTIVE"
  if (filters.approval_status === "CANCELLED") {
    chips.push({
      key: "approval_status",
      label: "Đã huỷ",
      patch: { approval_status: "ALL_ACTIVE" },
    });
  } else if (filters.approval_status === "UNAPPROVED") {
    chips.push({
      key: "approval_status",
      label: "Nháp",
      patch: { approval_status: "ALL_ACTIVE" },
    });
  } else if (filters.approval_status === "APPROVED") {
    chips.push({
      key: "approval_status",
      label: "Đã ghi nhận",
      patch: { approval_status: "ALL_ACTIVE" },
    });
  }

  if (filters.type) {
    chips.push({
      key: "type",
      label: filters.type === "INCOME" ? "Phiếu thu" : "Phiếu chi",
      patch: { type: null },
    });
  }

  if (filters.start_date || filters.end_date) {
    const fmt = (s?: string | null) =>
      s ? format(new Date(s), "dd/MM") : "...";
    chips.push({
      key: "start_date",
      label: `${fmt(filters.start_date)} → ${fmt(filters.end_date)}`,
      patch: { start_date: null, end_date: null },
    });
  }

  if (filters.period_start_month || filters.period_end_month) {
    // 'YYYY-MM' → 'MM/yyyy'
    const fmtM = (m?: string | null) => {
      if (!m) return "...";
      const [y, mo] = m.split("-");
      return `${mo}/${y}`;
    };
    chips.push({
      key: "period_start_month",
      label: `Kỳ: ${fmtM(filters.period_start_month)} → ${fmtM(filters.period_end_month)}`,
      patch: { period_start_month: null, period_end_month: null },
    });
  }

  if (filters.area_id && areas) {
    const a = areas.find((x) => x.id === filters.area_id);
    if (a)
      chips.push({
        key: "area_id",
        label: `KV: ${a.name}`,
        patch: {
          area_id: null,
          building_id: null,
          room_id: null,
        },
      });
  }

  if (filters.building_id && buildings) {
    const b = buildings.find((x) => x.id === filters.building_id);
    if (b)
      chips.push({
        key: "building_id",
        label: b.name,
        patch: { building_id: null, room_id: null },
      });
  }

  if (filters.income_type_id && incomeTypes) {
    const t = incomeTypes.find((x) => x.id === filters.income_type_id);
    if (t)
      chips.push({
        key: "income_type_id",
        label: `Thu: ${t.name}`,
        patch: { income_type_id: null },
      });
  }

  if (filters.expense_type_id && expenseTypes) {
    const t = expenseTypes.find((x) => x.id === filters.expense_type_id);
    if (t)
      chips.push({
        key: "expense_type_id",
        label: `Chi: ${t.name}`,
        patch: { expense_type_id: null },
      });
  }

  if (filters.account_id && accounts) {
    const acc = accounts.find((x) => x.id === filters.account_id);
    if (acc)
      chips.push({
        key: "account_id",
        label: `TK: ${acc.name}`,
        patch: { account_id: null },
      });
  }

  if (filters.verified_status === "VERIFIED") {
    chips.push({
      key: "verified_status",
      label: "Đã check",
      patch: { verified_status: null },
    });
  } else if (filters.verified_status === "UNVERIFIED") {
    chips.push({
      key: "verified_status",
      label: "Chưa check",
      patch: { verified_status: null },
    });
  }

  if (filters.creator_id && staffUsers) {
    const u = staffUsers.find((x) => x.id === filters.creator_id);
    if (u)
      chips.push({
        key: "creator_id",
        label: `Người tạo: ${u.full_name || u.email || "—"}`,
        patch: { creator_id: null },
      });
  }

  if (chips.length === 0) return null;

  return (
    <div
      className="flex gap-1.5 px-3 py-2 overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {chips.map((chip) => (
        <button
          key={String(chip.key) + chip.label}
          type="button"
          onClick={() => onChange({ ...filters, ...chip.patch })}
          className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium active:bg-blue-100"
        >
          {chip.label}
          <X className="h-3 w-3" />
        </button>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() => onChange(emptyFilters)}
          className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-full bg-zinc-100 border border-zinc-200 text-zinc-600 text-xs font-medium active:bg-zinc-200"
        >
          Xoá tất cả
        </button>
      )}
    </div>
  );
}

export default IncomeExpenseFilterChips;
