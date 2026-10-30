import { QueryRegion } from "@/components/errors/QueryRegion";
// "Lương của tôi" — trang TRỌN MÀN, mở ở TAB MỚI khi nhân viên bấm "Bảng lương" ở
// sidebar. Tự cô lập khỏi MainLayout: SalarySelfView tự dựng thanh đầu trang, cùng
// một component cho desktop và điện thoại (điện thoại thêm thanh tab dưới).
// Dùng chung dữ liệu SalManager + lùi-tháng-theo-chốt với trang Bảng lương quản lý.
import { useState } from "react";
import { SkeletonBar } from "@/components/loading/LoadingState";
import { useManagerSalary, useMyManagerConfig, useStaffDisplayMonth } from "@/hooks/useManagerSalary";
import { usePhoneViewport } from "@/hooks/use-mobile";
import { useSalaryV5Config } from "@/hooks/useSalaryV5Config";
import SalarySelfView from "@/components/salary/SalarySelfView";
import { currentPeriodMonth, shiftPeriodMonth as shiftMonth } from "@/lib/salaryPeriod";
import { resolveSalaryEngine } from "@/lib/managerSalary";
import { parseV5Plan } from "@/lib/salarySelfSummary";
import { useBonusRules } from "@/hooks/useSalaryConfig";

// Khung trọn màn cho trạng thái tải / chưa cấu hình.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background p-6 text-center text-foreground">
      {children}
    </div>
  );
}

export default function MySalaryPage() {
  const phone = usePhoneViewport();
  const managerConfigQuery = useMyManagerConfig();
  const { data: myMgr, isLoading: myLoading } = managerConfigQuery;
  const displayMonthQuery = useStaffDisplayMonth(myMgr?.staff_id, true);
  const {data:staffMonth} = displayMonthQuery;

  // Tháng đang xem: mặc định = tháng hiển thị (lùi theo chốt lương). Cho phép lùi
  // về lịch sử; chặn vượt quá mốc được phép xem (staffMonth) — giữ đúng chính sách.
  // hermes-parity:begin w2c-salary-locked — Hermes chép vùng này (app_private.hermes_w2c_read_v1: my_salary, trần tháng)
  const ceiling = staffMonth || currentPeriodMonth();
  const [override, setOverride] = useState<string | null>(null);
  const effPeriod = override || ceiling;
  // hermes-parity:end w2c-salary-locked

  // Chế độ lương (cũ/v5) — chỉ đổi SỐ LIỆU tháng chưa chốt, UI giữ nguyên.
  const engineQuery = useSalaryV5Config();
  const { data: v5cfg } = engineQuery;
  // v5 chỉ áp từ system_v5.effective_from trở đi — tháng trước đó rơi về legacy.
  const salaryEngine = resolveSalaryEngine(v5cfg, effPeriod);

  const salaryQuery = useManagerSalary(effPeriod, salaryEngine);
  const {data, isLoading} = salaryQuery;
  const rulesQuery = useBonusRules();
  const { data: rulesData } = rulesQuery;
  const requirePhoto = !!rulesData?.rules?.requirePhoto;

  const sources = [...(myMgr?.staff_id ? [displayMonthQuery] : []), managerConfigQuery, engineQuery, salaryQuery, rulesQuery];
  if (sources.some(query => query.isError)) return <Shell><QueryRegion label="bảng lương cá nhân" queries={sources}><p>Chưa tải đủ dữ liệu bảng lương.</p></QueryRegion></Shell>;
  if (sources.some(query => query.isLoading) || myLoading || (!data && isLoading)) {
    // Chờ: khối xám thay vòng xoay + chữ (chủ chốt 02/10/2026); câu chờ chỉ cho trình đọc màn hình.
    return <Shell>
      <div role="status" style={{ width: "100%", maxWidth: 420 }}>
        <span className="sr-only">Đang tải bảng lương…</span>
        <div className="ld-appear flex w-full flex-col gap-3" aria-hidden="true">
          <SkeletonBar className="h-5 rounded-lg" style={{ width: "40%" }} />
          <SkeletonBar className="h-28 rounded-2xl" style={{ width: "100%" }} />
          <SkeletonBar className="h-16 rounded-2xl" style={{ width: "100%" }} />
          <SkeletonBar className="h-16 rounded-2xl" style={{ width: "100%" }} />
        </div>
      </div>
    </Shell>;
  }

  const managers = data?.managers || [];

  if (!myMgr || managers.length === 0) {
    return (
      <Shell>
        <div style={{ maxWidth: 420 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Lương của tôi</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập.</p>
        </div>
      </Shell>
    );
  }

  const me = managers.find((m) => m.id === myMgr.staff_id) || managers[0];

  // hermes-parity:begin w2c-salary-locked — Hermes chép vùng này (app_private.hermes_w2c_read_v1: my_salary, không xem vượt trần)
  const canNext = effPeriod < ceiling;
  // hermes-parity:end w2c-salary-locked

  // Nhãn tháng suy TRỰC TIẾP từ effPeriod: React Query còn giữ data tháng cũ một nhịp
  // khi đổi tháng → nhãn sẽ hiện sai nếu lấy từ data.
  const [pyNum, pmNum] = effPeriod.split("-").map((x) => parseInt(x, 10));

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-background">
      <SalarySelfView
        m={me}
        period={{ label: `Tháng ${pmNum}`, year: pyNum }}
        v5Plan={salaryEngine === "v5" ? parseV5Plan(v5cfg) : null}
        phone={phone}
        onExit={phone ? () => window.close() : undefined}
        canPrev
        canNext={canNext}
        requirePhoto={requirePhoto}
        onPrevMonth={() => setOverride(shiftMonth(effPeriod, -1))}
        onNextMonth={() => { if (canNext) setOverride(shiftMonth(effPeriod, 1)); }}
      />
    </div>
  );
}
