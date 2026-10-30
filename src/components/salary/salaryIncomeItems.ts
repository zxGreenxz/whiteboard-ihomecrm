// Tách thu nhập một người thành từng khoản theo 3 nhóm nguồn chịu tiền (bản Claude
// Design 26/09/2026). MỘT nguồn cho tab "Thu nhập & thanh toán" của quản trị và trang
// "Lương của tôi" của nhân viên — hai màn đọc cùng danh sách nên luôn khớp từng đồng.
// Hàm thuần: chỉ đọc SalManager (useManagerSalary), không đổi công thức lương.
import { fundLinesOf, isSupplementaryLabel } from "@/lib/salaryFundReport";
import type { SalAdjustment, SalAppliedOverride, SalManager } from "@/lib/managerSalary";
import { RECURRING_CATEGORY_LABEL, RECURRING_SOURCE_LABEL } from "@/lib/salaryRecurring";
import type { ChipTone } from "./salaryFundUi";
import { salFmt } from "./salaryFormat";

export type IncomeGroupKey = "vh" | "sale" | "dh";
export const INCOME_GROUP: Record<IncomeGroupKey | "ded", { title: string; src: string; color: string }> = {
  vh: { title: "Lương vận hành", src: "Quỹ lương vận hành của công ty", color: "#188552" },
  sale: { title: "Hoa hồng & thưởng Sale", src: "Chi phí của tòa phát sinh giao dịch", color: "#6334b7" },
  dh: { title: "Thu nhập đồng hành", src: "Phần lợi nhuận được phân bổ theo tòa", color: "#0e7490" },
  ded: { title: "Ứng & cấn trừ", src: "Không phải thu nhập — giảm tiền thực chuyển", color: "#c32222" },
};

export interface IncomeItem {
  id: string;
  g: IncomeGroupKey;
  label: string;
  why: string;
  amount: number | null;
  chip: { t: string; tone: ChipTone };
  payable: boolean;
  strike?: boolean;
  trace: [string, string][];
  adj?: SalAdjustment;
  /** Khoá ghi đè số tiền (base, streak, job:…, rec:…, sale:…, dh:…) — không có thì không sửa được. */
  key?: string;
  /** Số máy tính (trước sửa tay). */
  computed?: number;
  ovr?: SalAppliedOverride | null;
  /** Hoa hồng ở sổ thật: phần đã/sẽ chi từ sổ đó — luôn đi kèm, trừ khỏi tiền chuyển. */
  paidElsewhere?: number;
  /** Phiếu HH chờ duyệt ở sổ thật — có thể gán quản lý để chuyển sang trả qua lương. */
  assignVoucherId?: string;
  assignVersion?: number;
}

// Dòng đã sửa tay: chip, dòng mô tả và các bước căn cứ hiện số máy tính + lý do.
function withOverride(it: IncomeItem, ovr: SalAppliedOverride | undefined): IncomeItem {
  if (!ovr) return { ...it, ovr: null, computed: it.amount ?? 0 };
  return {
    ...it,
    ovr,
    computed: ovr.computed,
    chip: { t: "Sửa tay", tone: "tasks" },
    why: `Máy tính ${salFmt(ovr.computed)} · ${ovr.reason}`,
    trace: [
      ...it.trace,
      ["Số máy tính", salFmt(ovr.computed)],
      ["Số đã sửa tay", `${salFmt(ovr.amount)} · ${ovr.reason}`],
      ["Người sửa", `${ovr.byName || "—"} · ${new Date(ovr.at).toLocaleString("vi-VN")}`],
    ],
  };
}

export function incomeItemsOf(m: SalManager): IncomeItem[] {
  const locked = m.status === "LOCKED";
  const out: IncomeItem[] = [];
  for (const l of fundLinesOf(m)) {
    // Khoản nhập tay đi riêng bên dưới để giữ id (sửa/xoá được); ở đây chỉ còn
    // dòng lệch theo số đã chốt của nhóm này.
    if (l.group === "extra" && l.key !== "extra-locked") continue;
    const isAdj = l.group === "extra";
    const key = l.key === "base" || (l.group === "work" && l.key !== "work-locked") ? l.key : undefined;
    out.push(withOverride({
      id: "vh:" + l.key, g: "vh", label: l.label, why: l.note || "", amount: l.amount, payable: true, key,
      chip: locked ? { t: "Đã chốt", tone: "success" } : isAdj ? { t: "Nhập tay", tone: "neutral" } : { t: "Tạm tính", tone: "warning" },
      trace: [
        ["Căn cứ", l.note || l.label],
        [l.group === "base" ? "Bằng chứng" : isAdj ? "Cách phát sinh" : "Bằng chứng",
          l.group === "base" ? `${m.workdays} ngày công · bảng kê công việc` : isAdj ? "Thưởng/Trừ nhập tay trong bảng lương" : `${m.stats.jobs} việc trong bảng kê · ${m.stats.repairs} việc sửa chữa`],
        ["Trạng thái kỳ", locked ? "Đã chốt — dùng số đóng băng" : "Chưa chốt — số có thể đổi đến khi chốt"],
        ["Nguồn chịu tiền", INCOME_GROUP.vh.src],
      ],
    }, key ? m.overrides?.[key] : undefined));
  }
  m.adjustments.filter((a) => a.recurring).forEach((a) => {
    const r = a.recurring!;
    const key = a.id as string;
    out.push(withOverride({
      id: key, g: "vh", label: a.label, amount: a.amount, payable: true, key,
      why: `${RECURRING_CATEGORY_LABEL[r.category]} định kỳ` + (a.note ? " · " + a.note : ""),
      chip: locked ? { t: "Đã chốt", tone: "success" } : { t: "Định kỳ", tone: "info" },
      trace: [
        ["Cách phát sinh", "Khoản định kỳ — tự áp mỗi kỳ theo phiên bản đang hiệu lực"],
        ["Loại", RECURRING_CATEGORY_LABEL[r.category] + (r.buildingName ? ` · ${r.buildingName}` : "")],
        ["Nguồn chịu tiền", RECURRING_SOURCE_LABEL[r.category] + (r.category === "SUPPLEMENTARY" ? " — không ghi vào thu chi của toà" : "")],
        ["Đổi mức / ngừng", "Nguồn lương & khoản định kỳ → Khoản định kỳ"],
      ],
    }, m.overrides?.[key]));
  });
  m.adjustments.filter((a) => !a.recurring).forEach((a, i) => out.push({
    id: "adj:" + (a.id || i), g: "vh", label: a.label, amount: a.amount, payable: true, adj: a,
    why: (a.amount < 0 ? "Trừ nhập tay" : "Thưởng nhập tay") + (a.note ? " · " + a.note : ""),
    chip: locked ? { t: "Đã chốt", tone: "success" } : { t: "Nhập tay", tone: "neutral" },
    trace: [
      ["Cách phát sinh", (a.amount < 0 ? "Trừ" : "Thưởng") + " nhập tay trong bảng lương"],
      ["Ghi chú", a.note || "—"],
      ["Phân loại báo cáo", a.amount < 0 ? "Khoản trừ" : isSupplementaryLabel(a.label) ? "Lương QL bổ sung (nhận theo nhãn)" : "Phụ cấp"],
      ["Nguồn chịu tiền", isSupplementaryLabel(a.label) && a.amount > 0 ? "Chủ cấp bổ sung" : INCOME_GROUP.vh.src],
    ],
  }));
  // Hoa hồng (migration 20260927155251, phương án A): phiếu ở sổ ảo "Hoa hồng QL chờ trả
  // lương" trả qua lương; phiếu ở sổ thật là thu nhập nhưng tiền đã/sẽ ra từ sổ đó, nên
  // luôn đi kèm (không bỏ chọn được) và bị trừ lại ở khung thanh toán.
  m.commissionItems.forEach((c, i) => {
    const key = c.voucherId ? "sale:" + c.voucherId : undefined;
    const fromBook = (c.paidElsewhere || 0) > 0;
    const book = c.paidFrom || "sổ quỹ khác";
    const status = c.approved ? "Đã duyệt (đã tính chi phí tòa)" : "Chờ duyệt — tự duyệt khi chốt lương";
    const chip: IncomeItem["chip"] = locked
      ? { t: "Đã chốt", tone: "success" }
      : !fromBook ? { t: "Trả qua lương", tone: "success" }
      : c.approved ? { t: "Đã chi từ sổ", tone: "neutral" }
      : { t: "Chưa gán QL", tone: "warning" };
    const why = !fromBook
      ? (locked ? "Đã chốt cùng bảng lương" : c.approved ? "Đã duyệt · trả qua lương" : "Chờ duyệt · tự duyệt khi chốt, trả qua lương")
      : c.approved ? `Đã chi từ sổ ${book} — tính thu nhập, không chuyển lại`
      : `Khi duyệt sẽ chi từ sổ ${book} — bấm để chuyển sang trả qua lương`;
    out.push(withOverride({
      id: "sale:" + (c.voucherId || i), g: "sale", label: c.label, amount: c.amount, payable: true, key, why, chip,
      paidElsewhere: fromBook ? c.paidElsewhere : 0,
      assignVoucherId: fromBook && !c.approved && !locked ? c.voucherId : undefined,
      assignVersion: c.version,
      trace: [
        ["Phiếu Sale nguồn", c.label],
        ["Quản lý nhận", c.assigned ? "Chọn ở ô QL của phiếu" : "Khớp tên người nhận trên phiếu"],
        ["Trạng thái phiếu", status],
        ["Sổ giữ tiền", fromBook ? `${book} (sổ thật) — tiền ra từ sổ này, lương không chuyển lại` : "Hoa hồng QL chờ trả lương (sổ ảo) — tiền trả qua lương"],
        ["Chi phí tòa", "Ghi một lần tại phiếu Sale nguồn — trả qua lương không ghi thêm"],
        ["Nguồn chịu tiền", INCOME_GROUP.sale.src],
      ],
    }, key ? m.overrides?.[key] : undefined));
  });
  m.commissionFlagged.forEach((c, i) => {
    const inc = c.includedElsewhere;
    const ky = inc ? inc.period.slice(5, 7) + "/" + inc.period.slice(0, 4) : "này";
    // Dấu khoá theo (phiếu, kỳ) và meta chỉ trả dấu của kỳ đang xem ⇒ ở đây luôn là
    // "đã tính cho NGƯỜI KHÁC trong kỳ này".
    out.push({
      id: "sale-paid:" + (c.voucherId || i), g: "sale", label: c.label, amount: c.amount, payable: false, strike: true,
      why: `Đã tính vào lương kỳ ${ky} của người khác — không cộng lại`,
      chip: { t: "Đã tính cho người khác", tone: "neutral" },
      trace: [
        ["Phiếu Sale nguồn", c.label],
        ["Dấu chốt lương", `Đã tính vào lương kỳ ${ky} của một quản lý khác`],
        ["Kết quả", "Không cộng vào thu nhập người này — mỗi phần hoa hồng chỉ vào lương một người"],
        ["Cần làm", "Nếu sai người: mở chốt lương người kia kỳ này rồi chốt lại"],
      ],
    });
  });
  if (!m.investmentLocked) {
    out.push({
      id: "dh:pending", g: "dh", label: "Lợi nhuận kỳ chưa chốt", amount: null, payable: false,
      why: "Chưa đủ cơ sở xác nhận — không phải bằng 0", chip: { t: "Lợi nhuận chưa chốt", tone: "warning" },
      trace: [["Trạng thái", "Lợi nhuận tòa chưa chốt"], ["Nguồn chịu tiền", INCOME_GROUP.dh.src]],
    });
  } else {
    m.investmentBy.forEach((a, i) => {
      const key = "dh:" + a.b;
      out.push(withOverride({
        id: "dh:" + a.b + i, g: "dh", label: `${a.b} · lợi nhuận kỳ`, amount: a.amount, payable: a.amount !== 0, key,
        why: a.amount > 0 ? "Đã chốt · phân bổ theo thỏa thuận hiện hành" : "Đã chốt · phần phân bổ bằng 0",
        chip: a.amount > 0 ? { t: "Đã xác nhận", tone: "success" } : { t: "Đã chốt · bằng 0", tone: "neutral" },
        trace: [["Tòa", a.b], ["Lợi nhuận tòa", "Đã chốt"], ["Thỏa thuận", "Tỷ lệ đọc từ thỏa thuận tòa"], ["Nguồn chịu tiền", INCOME_GROUP.dh.src]],
      }, m.overrides?.[key]));
    });
  }
  return out;
}
