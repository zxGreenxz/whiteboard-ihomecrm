// "Lương của tôi" — trang TRỌN MÀN (QUEST), mở ở TAB MỚI khi nhân viên bấm
// "Bảng lương" ở sidebar. Tự cô lập khỏi MainLayout: tự dựng chrome riêng (top bar
// + nền tối tím-vàng). Desktop → SalarySelfDesktop; điện thoại → SalarySelfMobile.
// Dùng chung dữ liệu SalManager + lùi-tháng-theo-chốt với trang Bảng lương quản lý.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useManagerSalary, useMyManagerConfig, useStaffDisplayMonth } from "@/hooks/useManagerSalary";
import { usePhoneViewport } from "@/hooks/use-mobile";
import SalarySelfDesktop from "@/components/salary/SalarySelfDesktop";
import SalarySelfMobile from "@/components/salary/SalarySelfMobile";

function shiftMonth(pm: string, delta: number): string {
  const [y, m] = pm.split("-").map((x) => parseInt(x, 10));
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
function currentPeriodMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// Khung trọn-màn nền tối cho trạng thái tải / chưa cấu hình (đồng bộ theme QUEST).
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", background: "radial-gradient(70% 50% at 50% -5%, #2a1f54 0%, transparent 55%), #15112A", color: "#EDEAF7", fontFamily: "'Be Vietnam Pro',sans-serif" }}>
      {children}
    </div>
  );
}

export default function MySalaryPage() {
  const phone = usePhoneViewport();
  const { data: myMgr, isLoading: myLoading } = useMyManagerConfig();
  const { data: staffMonth } = useStaffDisplayMonth(myMgr?.staff_id, true);

  // Tháng đang xem: mặc định = tháng hiển thị (lùi theo chốt lương). Cho phép lùi
  // về lịch sử; chặn vượt quá mốc được phép xem (staffMonth) — giữ đúng chính sách.
  const ceiling = staffMonth || currentPeriodMonth();
  const [override, setOverride] = useState<string | null>(null);
  const effPeriod = override || ceiling;

  const { data, isLoading } = useManagerSalary(effPeriod);

  if (myLoading || (!data && isLoading)) {
    return <Shell><div><Loader2 className="animate-spin" style={{ margin: "0 auto 10px", color: "#FFD23F" }} /><p style={{ fontSize: 14, color: "#9A8FC4" }}>Đang tải bảng lương…</p></div></Shell>;
  }

  const managers = data?.managers || [];
  const period = data?.period || { label: "", year: 0 };

  if (!myMgr || managers.length === 0) {
    return (
      <Shell>
        <div style={{ maxWidth: 420 }}>
          <h2 style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>Lương của tôi</h2>
          <p style={{ fontSize: 14, color: "#9A8FC4", lineHeight: 1.6 }}>Bạn chưa được cấu hình hưởng lương. Liên hệ quản trị để được thiết lập.</p>
        </div>
      </Shell>
    );
  }

  const me = managers.find((m) => m.id === myMgr.staff_id) || managers[0];

  if (phone) return <SalarySelfMobile m={me} period={period} onExit={() => window.close()} />;

  const canNext = effPeriod < ceiling;
  return (
    <SalarySelfDesktop
      m={me}
      period={period}
      canPrev
      canNext={canNext}
      onPrevMonth={() => setOverride(shiftMonth(effPeriod, -1))}
      onNextMonth={() => { if (canNext) setOverride(shiftMonth(effPeriod, 1)); }}
    />
  );
}
