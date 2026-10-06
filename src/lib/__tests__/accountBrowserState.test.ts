import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_UI_LOCAL_KEYS,
  ACCOUNT_UI_LOCAL_PREFIXES,
  clearAccountBrowserState,
  restartAtLogin,
} from "@/lib/accountBrowserState";

function memoryStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, keys: () => [...values.keys()].sort() };
}

describe("clearAccountBrowserState", () => {
  // Báo lỗi 06/10/2026: NATHAN thấy 0 hợp đồng vì tab giữ bộ lọc toà của tài khoản trước.
  it("xoá mọi khoá sessionStorage của tab, không chỉ bộ lọc báo cáo", () => {
    const session = memoryStorage({
      "flt:contracts:buildingIds": '["toa-cua-tai-khoan-truoc"]',
      "flt:contracts:room": '"P101"',
      "flt:rpt-business-performance:month": '"2026-09"',
      "hl:entered": "1",
      "invoices:overdue-checked-at": "1",
    });

    clearAccountBrowserState(session.storage, null);

    expect(session.keys()).toEqual([]);
  });

  it("chỉ xoá lựa chọn giao diện không gắn người dùng trong localStorage", () => {
    const local = memoryStorage({
      "invoice-list-column-visibility-v1": "{}",
      "ie-batch-list-column-visibility-v1": "{}",
      "ihome:quick-entry:last-account:org-1": "acc-1",
      // Phải giữ: phiên đăng nhập, nhật ký chống ghi trùng tiền, lựa chọn đã gắn userId, tuỳ chọn máy.
      "sb-tryymsxyyckgbrmmvozx-auth-token": "{}",
      "ihome:pending-collection:v1:user-a:org-1:inv-1": "{}",
      "ihome:financial-pending:v1:ns:user-a:org-1:key": "{}",
      "ihome:quick-entry:models:user-a": "{}",
      "ihomecrm.selectedOrganizationId:user-a": "{}",
      "pwa-install-hint-dismissed": "1",
    });

    clearAccountBrowserState(null, local.storage);

    expect(local.keys()).toEqual([
      "ihome:financial-pending:v1:ns:user-a:org-1:key",
      "ihome:pending-collection:v1:user-a:org-1:inv-1",
      "ihome:quick-entry:models:user-a",
      "ihomecrm.selectedOrganizationId:user-a",
      "pwa-install-hint-dismissed",
      "sb-tryymsxyyckgbrmmvozx-auth-token",
    ]);
  });

  it("không ném khi trình duyệt chặn bộ nhớ", () => {
    const blocked = {
      get length(): number {
        throw new DOMException("blocked", "SecurityError");
      },
      clear: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    } as unknown as Storage;

    expect(() => clearAccountBrowserState(blocked, blocked)).not.toThrow();
  });

  it("đăng xuất chủ động nạp lại hẳn trang /login", () => {
    const navigateDocument = vi.fn();

    restartAtLogin(navigateDocument);

    expect(navigateDocument).toHaveBeenCalledExactlyOnceWith("/login");
  });
});

// Mỗi file nguồn đọc/ghi localStorage phải được xếp loại ở đây. File mới chưa xếp
// loại là đỏ: người thêm phải quyết lựa chọn đó có được sang tài khoản kế tiếp không.
// "tai-khoan" = lựa chọn giao diện không gắn người dùng ⇒ phải có trong
// ACCOUNT_UI_LOCAL_KEYS/PREFIXES để clearAccountBrowserState dọn.
type LocalStorageRole =
  | "tai-khoan"
  | "gan-nguoi-dung"
  | "nhat-ky-chong-ghi-trung"
  | "phien-dang-nhap"
  | "tuy-chon-may"
  | "chi-chu-thich";

const LOCAL_STORAGE_FILES: Record<string, LocalStorageRole> = {
  "src/components/invoices/invoiceListColumns.ts": "tai-khoan",
  "src/components/income-expenses/batchListColumns.ts": "tai-khoan",
  "src/hooks/quick-entry/useQuickEntryRefs.ts": "tai-khoan",
  "src/pages/invoices/InvoicesPage.tsx": "chi-chu-thich",
  "src/lib/accountBrowserState.ts": "tai-khoan",
  "src/components/layout/useSidebarState.ts": "gan-nguoi-dung",
  "src/lib/companyPreference.ts": "gan-nguoi-dung",
  "src/hooks/quick-entry/useQuickEntryFeed.ts": "gan-nguoi-dung",
  "src/lib/quickEntry/models.ts": "gan-nguoi-dung",
  "src/pages/quick-entry/QuickEntryPage.tsx": "gan-nguoi-dung",
  "src/hooks/useScheduledNotifications.ts": "gan-nguoi-dung",
  "src/hooks/usePersonalTasks.ts": "gan-nguoi-dung",
  "src/hooks/usePersonalTaskReminders.ts": "gan-nguoi-dung",
  "src/hooks/personal-finance/usePersonalFinance.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/contractEditWorkflow.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/contractImportWorkflow.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/financialPending.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/pendingCollection.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/persistentFinancialWorkflow.ts": "nhat-ky-chong-ghi-trung",
  "src/hooks/income-expenses/batch.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/leadConversionProgress.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/templateDefaultIntent.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/luckyDrawApi.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/luckyProofPending.ts": "nhat-ky-chong-ghi-trung",
  "src/lib/network-center/intentRegistry.ts": "nhat-ky-chong-ghi-trung",
  "src/integrations/supabase/client.ts": "phien-dang-nhap",
  "src/hooks/useAuth.ts": "phien-dang-nhap",
  "src/lib/authSession.ts": "chi-chu-thich",
  "src/copilot/confirmationStore.ts": "chi-chu-thich",
  "src/components/pwa/InstallHint.tsx": "tuy-chon-may",
  "src/components/chat-zalo/composer/EmojiPicker.tsx": "tuy-chon-may",
  "src/pages/quayso/QuaySoPage.tsx": "tuy-chon-may",
  "src/pages/quayso/AnimalRaceTrack.tsx": "tuy-chon-may",
  "src/pages/phong-trong/PhongTrongPage.tsx": "tuy-chon-may",
  "src/pages/phong-trong/tracking.ts": "tuy-chon-may",
};

function sourceFilesUsingLocalStorage(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      if (readFileSync(full, "utf8").includes("localStorage")) found.push(full);
    }
  };
  walk(join(root, "src"));
  return found.map((file) => relative(root, file).split(sep).join("/")).sort();
}

describe("phân loại localStorage", () => {
  it("mọi file nguồn đọc/ghi localStorage đều đã được xếp loại", () => {
    expect(sourceFilesUsingLocalStorage(process.cwd())).toEqual(
      Object.keys(LOCAL_STORAGE_FILES).sort(),
    );
  });

  it("khoá của các file 'tai-khoan' nằm trong danh sách được dọn", () => {
    const root = process.cwd();
    const read = (file: string) => readFileSync(join(root, file), "utf8");
    expect(read("src/components/invoices/invoiceListColumns.ts")).toContain(`'${ACCOUNT_UI_LOCAL_KEYS[0]}'`);
    expect(read("src/components/income-expenses/batchListColumns.ts")).toContain(`'${ACCOUNT_UI_LOCAL_KEYS[1]}'`);
    expect(read("src/hooks/quick-entry/useQuickEntryRefs.ts")).toContain(`\`${ACCOUNT_UI_LOCAL_PREFIXES[0]}\${orgId}\``);
  });
});
