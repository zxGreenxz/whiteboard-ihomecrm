// Dữ liệu nền cho trang "Báo chi nhanh": quyền, toà/phòng, hạng mục chi dùng được, sổ quỹ đang giữ,
// mã khách hàng điện nước. Chỉ ghép các hook có sẵn — không truy vấn mới. Phần công ty chỉ tải khi
// người dùng có quyền lập phiếu chi (người chỉ có ví cá nhân không đụng dữ liệu thu chi).

import { useCallback, useMemo } from "react";
import { useOrganization } from "@/contexts/OrganizationContext";
import { useMyPermissions } from "@/hooks/useMyPermissions";
import { canUse } from "@/lib/permissionPages";
import { useIncomeExpenseFormBuildings, useIncomeExpenseFormRooms } from "@/hooks/useIncomeExpenseFormScope";
import { useIncomeExpenseTypes } from "@/hooks/useIncomeExpenseTypes";
import { useAccounts } from "@/hooks/useAccounts";
import { useCustodianCashbooksV2 } from "@/hooks/income-expenses/financeV2Mutations";
import { useFeeAccounts } from "@/hooks/usePeriodFees";
import { useUtilityAccounts } from "@/hooks/useUtilityBills";
import { usableExpenseCategories, type CategoryRef } from "@/lib/quickEntry/categorySuggest";
import { pickDefaultAccount } from "@/lib/quickEntry/cashbook";
import type { FeeAccountRef, ResolveRefs } from "@/lib/quickEntry/resolve";

const lastAccountKey = (orgId: string) => `ihome:quick-entry:last-account:${orgId}`;

/** Nhớ sổ vừa dùng để lần sau chọn sẵn (tiện ích theo máy; mất cũng không sao). */
export function rememberAccount(orgId: string | null, accountId: string | null): void {
  if (!orgId || !accountId) return;
  try {
    localStorage.setItem(lastAccountKey(orgId), accountId);
  } catch {
    // trình duyệt chặn lưu trữ ⇒ bỏ qua
  }
}

function lastAccount(orgId: string | null): string | null {
  if (!orgId) return null;
  let id: string | null = null;
  try {
    id = localStorage.getItem(lastAccountKey(orgId));
  } catch {
    // Trình duyệt chặn lưu trữ (chế độ riêng tư) ⇒ không có sổ nhớ; chỉ mất tiện ích chọn sẵn,
    // sổ vẫn rơi về sổ theo toà / sổ mặc định và người dùng vẫn chọn tay được.
  }
  return id;
}

export interface PickerOption {
  id: string;
  label: string;
}

export function useQuickEntryRefs() {
  const { selectedOrganizationId: orgId } = useOrganization();
  const permsQ = useMyPermissions();
  const perms = permsQ.data;
  const canCompany = canUse(perms, "income_expenses", "create");
  const canPersonal = canUse(perms, "personal_finance", "create");
  const canRestricted = canUse(perms, "income_expenses", "restricted_create");

  const buildingsQ = useIncomeExpenseFormBuildings({ enabled: canCompany });
  const roomsQ = useIncomeExpenseFormRooms(undefined, { allWhenEmpty: canCompany });
  const typesQ = useIncomeExpenseTypes("expense", { enabled: canCompany });
  const accountsQ = useAccounts({ enabled: canCompany });
  const cashbooksQ = useCustodianCashbooksV2(canCompany);
  const feeQ = useFeeAccounts({ enabled: canCompany });
  const utilQ = useUtilityAccounts({ enabled: canCompany });

  const buildings = useMemo(() => (canCompany ? buildingsQ.data ?? [] : []), [canCompany, buildingsQ.data]);
  const rooms = useMemo(() => (canCompany ? roomsQ.data ?? [] : []), [canCompany, roomsQ.data]);
  const cashbooks = useMemo<PickerOption[]>(
    () => (canCompany ? (cashbooksQ.data ?? []).map((c) => ({ id: c.id, label: c.name })) : []),
    [canCompany, cashbooksQ.data],
  );

  const categories = useMemo<CategoryRef[]>(() => {
    if (!canCompany || !orgId) return [];
    const rows = (typesQ.data ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      category: t.category,
      type: t.type,
      organization_id: t.organization_id,
      is_restricted: t.is_restricted,
      system_only: t.system_only ?? false,
      fee_category: t.fee_category ?? null,
    }));
    return usableExpenseCategories(rows, { organizationId: orgId, canUseRestricted: canRestricted });
  }, [canCompany, orgId, typesQ.data, canRestricted]);

  const resolveRefs = useMemo<ResolveRefs>(() => {
    const fees: FeeAccountRef[] = (feeQ.data ?? []).map((f) => ({
      building_id: f.buildingId,
      fee_category: f.feeCategory,
      provider_code: f.providerCode || null,
    }));
    const meters: FeeAccountRef[] = (utilQ.meters ?? []).map((m) => ({
      building_id: m.building_id,
      fee_category: m.type === "electric" ? "dien" : "nuoc",
      provider_code: m.code || null,
    }));
    return {
      buildings: buildings.map((b) => ({ id: b.id, name: b.name, code: b.code })),
      rooms: rooms.map((r) => ({ id: r.id, name: r.name, code: r.code, building_id: r.building_id })),
      feeAccounts: [...fees, ...meters],
    };
  }, [buildings, rooms, feeQ.data, utilQ.meters]);

  const accounts = accountsQ.data;
  const defaultAccountFor = useCallback(
    (buildingId: string | null) =>
      pickDefaultAccount({
        buildingId,
        usableIds: cashbooks.map((c) => c.id),
        accounts: (accounts ?? []).map((a) => ({
          id: a.id,
          is_default: a.is_default,
          quick_default_building_id: a.quick_default_building_id,
        })),
        lastUsedId: lastAccount(orgId),
      }),
    [cashbooks, accounts, orgId],
  );

  const loading =
    permsQ.isLoading || (canCompany && (buildingsQ.isLoading || typesQ.isLoading || cashbooksQ.isLoading));

  return {
    orgId,
    loading,
    canCompany,
    canPersonal,
    buildings,
    rooms,
    categories,
    cashbooks,
    resolveRefs,
    defaultAccountFor,
  };
}

export type QuickEntryRefs = ReturnType<typeof useQuickEntryRefs>;
