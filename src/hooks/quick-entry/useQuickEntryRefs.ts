// Dữ liệu nền cho trang "Báo chi nhanh": quyền, toà/phòng (kèm tên thường gọi của toà cho bộ dò đọc bằng
// lời), hạng mục chi dùng được, sổ quỹ đang giữ, mã khách hàng điện nước. Chỉ ghép các hook có sẵn. Phần
// công ty chỉ tải khi người dùng có quyền lập phiếu chi (người chỉ có ví cá nhân không đụng dữ liệu thu chi).

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
import { useBuildingCommonNames } from "@/hooks/useBuildingCommonNames";
import { usableExpenseCategories, type CategoryRef } from "@/lib/quickEntry/categorySuggest";
import { expenseCashbooksForOrg, pickDefaultAccount } from "@/lib/quickEntry/cashbook";
import type { FeeAccountRef, ResolveRefs } from "@/lib/quickEntry/resolve";
import { usePersonalFinance } from '@/hooks/personal-finance/usePersonalFinance';
import { usePersonalFinancePermissions } from '@/hooks/personal-finance/usePersonalFinancePermissions';
import { useCompanyWallets } from '@/hooks/company-wallet/useCompanyWallets';

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

export function useQuickEntryRefs(options?: {entrySource?:'personal_wallet'}) {
  const { selectedOrganizationId: orgId } = useOrganization();
  const permsQ = useMyPermissions();
  const personalPermsQ = usePersonalFinancePermissions();
  const perms = permsQ.data;
  const canCompany = !!orgId && !permsQ.error && canUse(perms, "income_expenses", "create");
  const canPersonal = personalPermsQ.data?.create === true;
  const canRestricted = canUse(perms, "income_expenses", "restricted_create");
  const personalQ=usePersonalFinance();
  const personalWallets=useMemo(()=>personalQ.data?.wallets??[],[personalQ.data]);
  const personalCategories=useMemo(()=>personalQ.data?.categories??[],[personalQ.data]);
  const walletScoped = options?.entrySource === 'personal_wallet';
  const companyWalletQ = useCompanyWallets(orgId, walletScoped && canCompany);
  const companyWallets = useMemo(() => companyWalletQ.data?.wallets ?? [], [companyWalletQ.data]);

  const buildingsQ = useIncomeExpenseFormBuildings({ enabled: canCompany });
  const roomsQ = useIncomeExpenseFormRooms(undefined, { allWhenEmpty: canCompany });
  const typesQ = useIncomeExpenseTypes(undefined, { enabled: canCompany });
  const accountsQ = useAccounts({ enabled: canCompany });
  const cashbooksQ = useCustodianCashbooksV2(canCompany);
  const feeQ = useFeeAccounts({ enabled: canCompany });
  const utilQ = useUtilityAccounts({ enabled: canCompany });
  // Thiếu tên thường gọi (lỗi/đang tải) chỉ làm bộ dò toà yếu hơn — không chặn trang, không vào `loading`.
  const namesQ = useBuildingCommonNames({ enabled: canCompany });

  const buildings = useMemo(() => (canCompany ? buildingsQ.data ?? [] : []), [canCompany, buildingsQ.data]);
  const rooms = useMemo(() => (canCompany ? roomsQ.data ?? [] : []), [canCompany, roomsQ.data]);
  // Chỉ sổ của CÔNG TY đang chọn (RPC trả sổ của mọi công ty người dùng thuộc về), bỏ sổ ảo.
  const cashbooks = useMemo<PickerOption[]>(
    () =>
      canCompany
        ? expenseCashbooksForOrg(cashbooksQ.data ?? [], accountsQ.data, orgId)
            .filter(c => !walletScoped || companyWallets.some(w => w.account_id === c.id && !w.hidden && w.can_use))
            .map((c) => ({ id: c.id, label: walletScoped ? companyWallets.find(w => w.account_id === c.id)?.name ?? c.name : c.name }))
        : [],
    [canCompany, cashbooksQ.data, accountsQ.data, orgId, walletScoped, companyWallets],
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
      // Danh mục chi chuẩn (03/10/2026): lọc/xếp + "dùng cho"/"hay nói" gửi AI + neo luật chọn.
      description: t.description ?? null,
      keywords: t.keywords ?? [],
      rule_key: t.rule_key ?? null,
      archived_at: t.archived_at ?? null,
      manual_hidden: t.manual_hidden ?? false,
      quick_entry_hidden: t.quick_entry_hidden ?? false,
      sort_order: t.sort_order ?? null,
      is_deposit: t.is_deposit ?? false,
    }));
    return [...usableExpenseCategories(rows, { organizationId: orgId, canUseRestricted: canRestricted }),...usableExpenseCategories(rows, { organizationId: orgId, canUseRestricted: canRestricted,type:'income' })];
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
    const names = namesQ.data;
    return {
      buildings: buildings.map((b) => ({ id: b.id, name: b.name, code: b.code, commonNames: names?.get(b.id) ?? null })),
      rooms: rooms.map((r) => ({ id: r.id, name: r.name, code: r.code, building_id: r.building_id })),
      feeAccounts: [...fees, ...meters],
    };
  }, [buildings, rooms, feeQ.data, utilQ.meters, namesQ.data]);

  const accounts = accountsQ.data;
  const defaultAccountFor = useCallback(
    (buildingId: string | null) =>
      walletScoped ? null : pickDefaultAccount({
        buildingId,
        usableIds: cashbooks.map((c) => c.id),
        accounts: (accounts ?? []).map((a) => ({
          id: a.id,
          is_default: a.is_default,
          quick_default_building_id: a.quick_default_building_id,
        })),
        lastUsedId: lastAccount(orgId),
      }),
    [cashbooks, accounts, orgId, walletScoped],
  );

  const loading =
    personalPermsQ.isPending || (!!orgId && permsQ.isPending) ||
    (canCompany && (buildingsQ.isLoading || typesQ.isLoading || cashbooksQ.isLoading || accountsQ.isLoading));

  return {
    orgId,
    loading,
    permissionsLoading:personalPermsQ.isPending || (!!orgId && permsQ.isPending),
    permissionsError:personalPermsQ.error ?? (orgId ? permsQ.error : null),
    personalPermissionsLoading:personalPermsQ.isPending,
    personalPermissionsError:personalPermsQ.error,
    companyPermissionsLoading:!!orgId && permsQ.isPending,
    companyPermissionsError:orgId ? permsQ.error : null,
    personalLoading:personalQ.isLoading,
    personalError:personalQ.error,
    personalReady:!!personalQ.data&&!personalQ.error,
    personalWallets,
    personalCategories,
    companyWallets,
    companyLoading:canCompany&&(buildingsQ.isLoading||typesQ.isLoading||cashbooksQ.isLoading||accountsQ.isLoading||(walletScoped&&companyWalletQ.isLoading)),
    companyError:buildingsQ.error??typesQ.error??cashbooksQ.error??accountsQ.error??(walletScoped?companyWalletQ.error:null),
    companyReady:canCompany&&!!buildingsQ.data&&!!typesQ.data&&!!cashbooksQ.data&&!!accountsQ.data&&(!walletScoped||!!companyWalletQ.data&&!companyWalletQ.error),
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
