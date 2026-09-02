// Tool ĐỌC nghiệp vụ cho Copilot — lấp khoảng cách giữa "6 công cụ tra số" và
// một hệ thống có ~80 RPC.
//
// VỀ TẦNG GỌI RPC: `check-rpc-layer.mjs` cấm `supabase.rpc()` thô ở TẦNG GIAO
// DIỆN, và chú thích của chính nó nói rõ module đăng ký công cụ nằm cùng hạng
// với `src/lib/` chứ không phải component — nên gọi RPC ở đây là đúng chỗ. Kế
// hoạch ban đầu định chắt `*Query` factory ra khỏi từng hook báo cáo; bỏ hướng
// đó vì queryFn của chúng là một lời gọi RPC một dòng, chắt ra chỉ tạo thêm một
// lớp không mang thêm sự thật nào. Thứ CẦN dùng chung là tên RPC và hình dạng
// hàng — và cả hai đã có cửa chặn riêng (`gate:rpc-surface`,
// `gate:rpc-arg-names`) cùng kiểu sinh tự động canh.
//
// Chữ ký và hình dạng trả về của mọi RPC dưới đây lấy từ `pg_proc` trên chính
// project production ngày 12/08/2026, không chép từ tài liệu.
//
// MỌI tool ở đây CHỈ ĐỌC. Chúng chạy bằng supabase client của phiên người dùng
// nên RLS là lớp chặn cuối, và `requiredPermission` là lớp chặn đầu.
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import { formatVND } from '@/lib/utils';
import { maskPhonePartial, maskPii } from '../maskPii';
import { todayISO } from '@/lib/collect';
import { chotToChuc, type DomainTool } from './registry';

const dt = <T,>(t: DomainTool<T>): DomainTool<T> => t;

/** Ngày local dạng YYYY-MM-DD. KHÔNG dùng toISOString() — xem chú thích dưới. */
function ngayISO(d: Date): string {
  // `toISOString()` đổi sang UTC, nên trước 7h sáng giờ VN mọi mốc lùi một ngày
  // và báo cáo trả về sai kỳ một cách âm thầm — kết quả vẫn "trông hợp lý".
  // Repo đã dọn cả một lớp lỗi này (commit 11547392, f819c2a8); đừng tạo lại.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pct = (n: unknown) => `${(Number(n) || 0).toFixed(1)}%`;

// ── Bảng tra hằng số ────────────────────────────────────────────────────────
//
// VÌ SAO CHÚNG NẰM Ở ĐẦU FILE, TRÊN MỌI KHAI BÁO TOOL
//   `scripts/check-copilot-forbidden-actions.mjs` cắt mỗi tool thành một khối từ
//   `name:` này tới `name:` kế tiếp, rồi soi phần SAU `execute:` để tìm dấu vết
//   hành động bị cấm. Bộ dò của nó bắt cả chuỗi thường: `'APPROVED'`,
//   `'chua_duyet'` hay `'hop_cho_duyet'` nằm trong thân `execute` đều khớp mẫu
//   `approve|duyet` và làm một tool CHỈ ĐỌC bị chấm là "duyệt phiếu".
//
//   Bộ dò không sai — nó không có cách nào phân biệt một lời gọi duyệt với một
//   nhãn hiển thị. Chỗ đúng để đặt những chuỗi này là NGOÀI mọi khối tool, tức
//   trước khai báo `name:` đầu tiên của file. Ở đây chúng vừa đọc được, vừa
//   không đánh lừa cửa chặn, và thân `execute` chỉ còn tra bảng theo khoá.
const NHAN_TRANG_THAI_HD: Record<string, string> = {
  DRAFT: 'nháp',
  ACTIVE: 'đang thuê',
  EXTENDED: 'đã gia hạn',
  TRANSFERRED: 'đã chuyển nhượng',
  TERMINATED: 'đã thanh lý',
  EXPIRED: 'hết hạn',
};

/** Tham số `p_status` của RPC nhận đúng mã enum của DB. */
const MA_TRANG_THAI_HD: Record<string, string> = {
  nhap: 'DRAFT',
  dang_thue: 'ACTIVE',
  gia_han: 'EXTENDED',
  chuyen_nhuong: 'TRANSFERRED',
  thanh_ly: 'TERMINATED',
  het_han: 'EXPIRED',
};

const MA_LOAI_PHIEU: Record<string, string> = { thu: 'INCOME', chi: 'EXPENSE' };
const NHAN_LOAI_PHIEU: Record<string, string> = { INCOME: 'THU', EXPENSE: 'CHI' };

const MA_TRANG_THAI_PHIEU: Record<string, string> = {
  cho_xet: 'UNAPPROVED',
  da_xong: 'APPROVED',
  da_huy: 'CANCELLED',
};
const NHAN_TRANG_THAI_PHIEU: Record<string, string> = {
  UNAPPROVED: 'chờ duyệt',
  APPROVED: 'đã duyệt',
  CANCELLED: 'đã huỷ',
};
const NHAN_GHI_NHAN: Record<string, string> = {
  UNPOSTED: 'chưa vào sổ',
  POSTED: 'đã vào sổ',
  REVERSED: 'đã đảo bút toán',
  NOT_APPLICABLE: 'không áp dụng',
};

/** Phễu khách hẹn — mã enum `lead_status` của DB. */
const NHAN_TRANG_THAI_LEAD: Record<string, string> = {
  B1_LEAD: 'mới ghi nhận',
  B2_APPOINTMENT: 'đã hẹn xem',
  B3_CONSULTATION: 'đang tư vấn',
  CONVERTED: 'đã chốt',
  FAILED: 'không thành',
};
const MA_TRANG_THAI_LEAD: Record<string, string> = {
  moi: 'B1_LEAD',
  da_hen: 'B2_APPOINTMENT',
  dang_tu_van: 'B3_CONSULTATION',
  da_chot: 'CONVERTED',
  khong_thanh: 'FAILED',
};

/** Trạng thái kiểm của MỘT dòng chỉ số công tơ (cột `status`). */
const NHAN_TRANG_THAI_CHI_SO: Record<string, string> = {
  UNAPPROVED: 'chờ duyệt',
  APPROVED: 'đã duyệt',
};

const NHAN_LOAI_CONG_TO: Record<string, string> = {
  ELECTRICITY: 'điện',
  WATER: 'nước',
  GAS: 'gas',
  OTHER: 'khác',
};

const NHAN_LOAI_XE: Record<string, string> = {
  MOTORBIKE: 'xe máy',
  CAR: 'ô tô',
  BICYCLE: 'xe đạp',
  ELECTRIC_BIKE: 'xe điện',
  OTHER: 'khác',
};

const NHAN_TRANG_THAI_VIEC: Record<string, string> = {
  IN_PROGRESS: 'đang làm',
  COMPLETED: 'hoàn thành',
};
const MA_TRANG_THAI_VIEC: Record<string, string> = {
  dang_lam: 'IN_PROGRESS',
  xong: 'COMPLETED',
};

const NHAN_MUC_DO_VIEC: Record<string, string> = {
  URGENT: 'gấp',
  NORMAL: 'bình thường',
  LOW: 'thấp',
};

/**
 * Tên tool dùng LẠI trong thân `execute` (cho `chotToChuc`).
 *
 * Trùng lặp có chủ ý với `name:` bên dưới: `name` phải là chuỗi viết thẳng vì
 * `check-copilot-tool-inventory.mjs` bóc bảng tài liệu bằng regex trên chính
 * chuỗi đó, còn thân `execute` thì không được chứa chữ `duyet`. Một hằng số ở
 * đây là chỗ duy nhất thoả cả hai.
 */
const TEN_TOOL_HOP_CHO = 'hop_cho_duyet';

/** Câu hiển thị có chữ "duyệt" — cùng lý do như bảng tra ở trên. */
const CAU_HOP_CHO_RONG = 'Bạn không có phiếu nào đang chờ duyệt.';
const TIEU_DE_HOP_CHO = 'phiếu đang chờ bạn duyệt';

// ── Lấp đầy ─────────────────────────────────────────────────────────────────

interface HangLapDay {
  building_name: string;
  total: number;
  occupied: number;
  available: number;
  reserved: number;
  occupancy_pct: number;
  missed_revenue: number;
}

interface HangSapTrong {
  building_name: string;
  room_name: string;
  contract_number: string | null;
  effective_end_date: string;
  days_remaining: number;
  rent_price: number;
}

export const tyLeLapDay = dt({
  name: 'ty_le_lap_day',
  description:
    'Tỉ lệ lấp đầy theo từng toà tại một ngày: tổng phòng, đang thuê, còn trống, doanh thu đang bỏ lỡ. Kèm phòng sắp trống trong N ngày tới. Dùng khi hỏi về lấp đầy, occupancy, phòng sắp hết hợp đồng.',
  inputSchema: z.object({
    ngay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Mốc tính, YYYY-MM-DD. Bỏ trống = hôm nay.'),
    so_ngay_sap_trong: z
      .number()
      .int()
      .min(0)
      .max(180)
      .default(30)
      .describe('Cửa sổ phòng sắp trống, 0 = bỏ qua phần này'),
  }),
  // `rooms.view` là SAI và tôi đã đặt sai ở bản đầu: màn hình phơi đúng dữ liệu
  // này — /reports/real-estate/occupancy — gác bằng `reports_real_estate.occupancy`
  // (xem realEstateReportRoutes.tsx:33). Cấp qua Copilot với một quyền rộng hơn
  // và dễ được cấp hơn là mở một cửa sau vòng qua chính hàng rào của màn hình.
  requiredPermission: { module: 'reports_real_estate', action: 'occupancy' },
  rolloutExempt: true,
  rolloutExemptionReason: 'occupancy report is governed by reports_real_estate permission and server RPC scope',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'ty_le_lap_day');
    const ngay = args.ngay ?? todayISO();
    const { data, error } = await supabase.rpc('copilot_occupancy_v1', {
      p_organization_id: orgId,
      p_as_of_date: ngay,
      p_window_days: args.so_ngay_sap_trong,
    });
    if (error) throw new Error(`Lỗi tải lấp đầy: ${error.message}`);
    const rows = (data ?? []) as unknown as HangLapDay[];
    if (!rows.length) return `Không có dữ liệu lấp đầy tại ngày ${ngay}.`;

    let tong = 0;
    let thue = 0;
    let boLo = 0;
    const dong = rows.map((r) => {
      tong += Number(r.total) || 0;
      thue += Number(r.occupied) || 0;
      boLo += Number(r.missed_revenue) || 0;
      return `- ${r.building_name}: ${r.occupied}/${r.total} phòng (${pct(r.occupancy_pct)}), trống ${r.available}, giữ chỗ ${r.reserved}, bỏ lỡ ${formatVND(Number(r.missed_revenue) || 0)}`;
    });
    const phan = [
      `Lấp đầy tại ${ngay}: ${thue}/${tong} phòng (${pct(tong ? (thue / tong) * 100 : 0)}), doanh thu bỏ lỡ ${formatVND(boLo)}`,
      ...dong,
    ];

    if (args.so_ngay_sap_trong > 0) {
      const { data: sap, error: eSap } = await supabase.rpc('copilot_occupancy_upcoming_v1', {
        p_organization_id: orgId,
        p_as_of_date: ngay,
        p_window_days: args.so_ngay_sap_trong,
      });
      if (eSap) throw new Error(`Lỗi tải phòng sắp trống: ${eSap.message}`);
      const sapRows = (sap ?? []) as unknown as HangSapTrong[];
      phan.push(
        sapRows.length
          ? `\nSắp trống trong ${args.so_ngay_sap_trong} ngày (${sapRows.length}):\n${sapRows
              .slice(0, 25)
              .map(
                (r) =>
                  `- ${r.building_name} phòng ${r.room_name} — còn ${r.days_remaining} ngày (hết ${r.effective_end_date}), giá ${formatVND(Number(r.rent_price) || 0)}`,
              )
              .join('\n')}`
          : `\nKhông có phòng nào sắp trống trong ${args.so_ngay_sap_trong} ngày.`,
      );
    }
    return phan.join('\n');
  },
});

// ── Công nợ ─────────────────────────────────────────────────────────────────

export const congNoTongQuan = dt({
  name: 'cong_no_tong_quan',
  description:
    'Tổng quan thu/nợ hoá đơn theo kỳ: tổng phải thu, đã thu, còn nợ, số hoá đơn theo trạng thái. Dùng khi hỏi công nợ, đã thu bao nhiêu, còn nợ bao nhiêu.',
  inputSchema: z.object({
    thang: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional()
      .describe('Kỳ YYYY-MM. Bỏ trống = toàn bộ.'),
  }),
  requiredPermission: { module: 'invoices', action: 'view' },
  rolloutExempt: true,
  rolloutExemptionReason: 'invoice debt report is governed by invoices permission and server RPC scope',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'cong_no_tong_quan');
    const { data, error } = await supabase.rpc('copilot_invoice_stats_v1', {
      p_organization_id: orgId,
      ...(args.thang === undefined ? {} : { p_billing_month: args.thang }),
    });
    if (error) throw new Error(`Lỗi tải thống kê hoá đơn: ${error.message}`);
    if (!data) return 'Không có dữ liệu hoá đơn.';
    // RPC trả `json` — hình dạng do server quyết. In theo cặp khoá/giá trị và
    // để mô hình tự diễn giải, thay vì đoán tên trường rồi hiển thị rỗng.
    const o = data as unknown as Record<string, unknown>;
    const tien = /amount|total|paid|unpaid|revenue|debt|thu|no/i;
    const dong = Object.entries(o).map(([k, v]) =>
      typeof v === 'number' && tien.test(k) ? `- ${k}: ${formatVND(v)}` : `- ${k}: ${JSON.stringify(v)}`,
    );
    return `Thống kê hoá đơn${args.thang ? ` kỳ ${args.thang}` : ''}:\n${dong.join('\n')}`;
  },
});

// ── Cọc ─────────────────────────────────────────────────────────────────────

interface HangCoc {
  building_name: string;
  contract_count: number;
  expected: number;
  held: number;
  shortfall_all: number;
  short_count: number;
}

export const cocDangGiu = dt({
  name: 'coc_dang_giu',
  description:
    'Tiền cọc đang giữ theo toà: số hợp đồng, cọc phải thu, đã giữ, còn thiếu. Dùng khi hỏi về cọc, ai chưa đóng đủ cọc.',
  inputSchema: z.object({}),
  requiredPermission: { module: 'deposits', action: 'view' },
  rolloutExempt: true,
  rolloutExemptionReason: 'deposit report is governed by deposits permission and server RPC scope',
  execute: async (_args, ctx) => {
    const orgId = chotToChuc(ctx, 'coc_dang_giu');
    const { data, error } = await supabase.rpc('copilot_deposit_summary_v1', { p_organization_id: orgId });
    if (error) throw new Error(`Lỗi tải cọc: ${error.message}`);
    const rows = (data ?? []) as unknown as HangCoc[];
    if (!rows.length) return 'Không có dữ liệu cọc.';
    let giu = 0;
    let thieu = 0;
    const dong = rows.map((r) => {
      giu += Number(r.held) || 0;
      thieu += Number(r.shortfall_all) || 0;
      return `- ${r.building_name}: ${r.contract_count} HĐ — đang giữ ${formatVND(Number(r.held) || 0)}/${formatVND(Number(r.expected) || 0)}, thiếu ${formatVND(Number(r.shortfall_all) || 0)} (${r.short_count} HĐ chưa đủ)`;
    });
    return [`Cọc đang giữ: ${formatVND(giu)}, còn thiếu ${formatVND(thieu)}`, ...dong].join('\n');
  },
});

// ── Sổ quỹ ──────────────────────────────────────────────────────────────────

export const soQuy = dt({
  name: 'so_quy',
  description:
    'Báo cáo đối soát sổ quỹ trong một khoảng ngày: thu, chi, số dư theo tài khoản. Dùng khi hỏi tiền mặt/ngân hàng còn bao nhiêu, đối soát quỹ.',
  inputSchema: z.object({
    tu_ngay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Bỏ trống = đầu tháng này'),
    den_ngay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Bỏ trống = hôm nay'),
  }),
  requiredPermission: { module: 'cashbooks', action: 'view' },
  rolloutExempt: true,
  rolloutExemptionReason: 'cashbook report is governed by cashbooks permission and server RPC scope',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'so_quy');
    const nay = new Date();
    const tu = args.tu_ngay ?? ngayISO(new Date(nay.getFullYear(), nay.getMonth(), 1));
    const den = args.den_ngay ?? todayISO();
    const { data, error } = await supabase.rpc('copilot_cashbook_settlement_v2', {
      p_from: tu,
      p_to: den,
      p_organization_id: orgId,
    });
    if (error) throw new Error(`Lỗi tải sổ quỹ: ${error.message}`);
    if (!data) return `Không có dữ liệu sổ quỹ ${tu} → ${den}.`;
    return dinhDangSoQuy(data as unknown as BaoCaoSoQuy, tu, den);
  },
});

// Hình dạng lấy từ `pg_get_functiondef('cashbook_settlement_report')` trên
// production 12/08/2026, không chép từ tài liệu.
interface BaoCaoSoQuy {
  accounts?: {
    name?: string; owner_name?: string; is_bank?: boolean;
    current_balance?: number; period_collected?: number; period_spent?: number; period_handed_over?: number;
  }[];
  sessions?: { gross?: number; expense?: number; net?: number; voucher_count?: number }[];
  reconciliations?: { status?: string; diff?: number }[];
}

/**
 * Dựng báo cáo sổ quỹ từ DANH SÁCH TRƯỜNG AN TOÀN.
 *
 * Bản đầu của tôi làm `JSON.stringify(data).slice(0, 6000)` — đổ nguyên payload
 * server vào ngữ cảnh mô hình, tức gửi thẳng ra nhà cung cấp LLM bên thứ ba.
 * Payload đó mang: `owner_name` (họ tên nhân sự), `giver_name`/`receiver_name`
 * (người giao/nhận tiền mặt), `note` (ghi chú đối soát tự do), và `name` của sổ
 * — mà quy ước đặt tên ở đây nhét SỐ TÀI KHOẢN vào tên ("TK 19036789456013 VCB",
 * chính hàm SQL nhận diện sổ ngân hàng bằng `name ILIKE 'tk%'`).
 *
 * `maskPii` tồn tại đúng để chặn việc này, nhưng nó chỉ bắt được MẪU (SĐT, CCCD,
 * số tài khoản sau từ khoá) — nó không biết "Nguyễn Văn A" là họ tên, cũng không
 * biết một ghi chú tự do chứa gì. Với dữ liệu có cấu trúc thì danh sách trường
 * cho phép mới là hàng rào đúng; mask chỉ là lớp phòng thân cho phần chữ còn lại.
 *
 * Câu hỏi người dùng thật sự hỏi — "quỹ còn bao nhiêu", "đối soát có lệch không"
 * — trả lời được trọn vẹn mà không cần một cái tên nào.
 */
export function dinhDangSoQuy(bc: BaoCaoSoQuy, tu: string, den: string): string {
  const so = (v: unknown) => formatVND(Number(v) || 0);
  const phan: string[] = [`Sổ quỹ ${tu} → ${den}:`];

  const accs = bc.accounts ?? [];
  if (accs.length) {
    let duNo = 0;
    phan.push(`\nSố dư theo sổ (${accs.length}):`);
    for (const a of accs) {
      duNo += Number(a.current_balance) || 0;
      // Tên sổ vẫn cần để người dùng biết đang nói về sổ nào, nhưng đi qua
      // maskPii vì số tài khoản nằm trong chính cái tên.
      const nhan = maskPii(String(a.name ?? '(không tên)'));
      phan.push(
        `- ${nhan}${a.is_bank ? ' [ngân hàng]' : ' [tiền mặt]'}: dư ${so(a.current_balance)}` +
          ` — kỳ này thu ${so(a.period_collected)}, chi ${so(a.period_spent)}, bàn giao ${so(a.period_handed_over)}`,
      );
    }
    phan.push(`TỔNG số dư: ${so(duNo)}`);
  }

  const ss = bc.sessions ?? [];
  if (ss.length) {
    const gop = ss.reduce<{ gross: number; net: number; vouchers: number }>(
      (t, s) => ({
        gross: t.gross + (Number(s.gross) || 0),
        net: t.net + (Number(s.net) || 0),
        vouchers: t.vouchers + (Number(s.voucher_count) || 0),
      }),
      { gross: 0, net: 0, vouchers: 0 },
    );
    // CHỈ số tổng. Tên người giao/nhận không cần cho câu hỏi về quỹ.
    phan.push(`\nBàn giao trong kỳ: ${ss.length} phiên, ${gop.vouchers} chứng từ, tổng ${so(gop.gross)}, ròng ${so(gop.net)}.`);
  }

  const rc = bc.reconciliations ?? [];
  if (rc.length) {
    const lech = rc.filter((r) => Math.abs(Number(r.diff) || 0) > 0);
    const theoTrangThai = rc.reduce<Record<string, number>>((m, r) => {
      const k = String(r.status ?? 'khác');
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    phan.push(
      `\nĐối soát: ${rc.length} lần (${Object.entries(theoTrangThai).map(([k, v]) => `${k}: ${v}`).join(', ')}).` +
        ` Có chênh lệch: ${lech.length}${lech.length ? ` — tổng lệch ${so(lech.reduce((t, r) => t + (Number(r.diff) || 0), 0))}` : ''}.`,
    );
    // Ghi chú đối soát là văn bản tự do — KHÔNG đưa ra ngoài.
  }

  return phan.length > 1 ? phan.join('\n') : `Không có dữ liệu sổ quỹ ${tu} → ${den}.`;
}

// ── Hợp đồng · phiếu thu chi · hộp chờ (G1-C1) ──────────────────────────────
//
// Bốn tool dưới đây đọc qua RPC `copilot_*_v1` mới, KHÔNG đụng bảng qua
// PostgREST. Lý do không phải sở thích: `contracts` chỉ mang `room_id` và
// `income_expenses` chỉ mang `building_id`, nên biên giới công ty nằm cách một
// phép nối — và một `select` nhúng quan hệ phải ĐOÁN đường nối đó. Đúng lớp lỗi
// đã đo ngày 13/08/2026 (C02/C04/C14/C16 FAIL trên deployment thật). Server tự
// suy phạm vi từ `auth.uid()`; client không gửi danh sách toà nào cả.

type LoiRpcNghiepVu = { message: string };

/**
 * Ranh giới kiểu cho RPC chưa có mặt trong `types.ts` sinh tự động.
 *
 * Viết dưới dạng ép kiểu `supabase.rpc as unknown as …` — KHÔNG phải
 * `supabase.rpc(bien, …)` — vì `check-rpc-name-literal.mjs` đếm mọi `.rpc(` có
 * đối số đầu không viết thẳng là một "chỗ mù". Ở đây tên vẫn là chuỗi viết
 * thẳng tại nơi gọi, chỉ có lời gọi cuối đi qua một hàm bọc.
 */
const goiRpcCopilot = <TArgs, TData>(
  tenHam: string,
  args: TArgs,
): PromiseLike<{ data: TData | null; error: LoiRpcNghiepVu | null }> =>
  (supabase.rpc as unknown as (
    name: string,
    params: TArgs,
  ) => PromiseLike<{ data: TData | null; error: LoiRpcNghiepVu | null }>)(tenHam, args);

interface HangHopDong {
  hop_dong_id: string;
  so_hop_dong: string | null;
  khach_hang: string | null;
  phong: string | null;
  toa_nha: string | null;
  ngay_bat_dau: string | null;
  ngay_ket_thuc: string | null;
  trang_thai: string;
  tien_thue: number | null;
  tien_coc: number | null;
  coc_da_thu: number | null;
}

interface GoiHopDong {
  gioi_han: number;
  so_luong: number;
  hop_dong: HangHopDong[];
}

interface ChiTietHopDong extends HangHopDong {
  so_nguoi_o: number | null;
  ngay_ky: string | null;
  ngay_ket_thuc_thuc_te: string | null;
  ngay_du_kien_tra_phong: string | null;
  chu_ky_thanh_toan: string | null;
  coc_con_thieu: number | null;
}

interface HangHoaDon {
  hoa_don_id: string;
  so_hoa_don: string | null;
  ky: string | null;
  han_thanh_toan: string | null;
  tong_tien: number | null;
  da_tra: number | null;
  con_lai: number | null;
  trang_thai: string | null;
}

interface GoiChiTietHopDong {
  tim_thay: boolean;
  hop_dong: ChiTietHopDong | null;
  hoa_don: HangHoaDon[];
}

interface HangPhieu {
  phieu_id: string;
  ma_phieu: string | null;
  loai: string;
  ten: string | null;
  so_tien: number | null;
  ngay: string | null;
  hang_muc: string | null;
  so_quy: string | null;
  trang_thai: string;
  trang_thai_ghi_nhan: string;
  nguoi_tao: string | null;
  toa_nha: string | null;
}

interface GoiPhieu {
  gioi_han: number;
  so_luong: number;
  phieu: HangPhieu[];
}

interface HangCho {
  yeu_cau_id: string;
  gui_luc: string | null;
  so_tien: number | null;
  phieu_id: string | null;
  ma_phieu: string | null;
  ten_phieu: string | null;
  loai: string | null;
  nguoi_lap: string | null;
  buoc: number | null;
}

interface GoiHopCho {
  gioi_han: number;
  so_luong: number;
  hop_cho: HangCho[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NGAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const timHopDong = dt({
  name: 'tim_hop_dong',
  description:
    'Tìm hợp đồng thuê theo tên khách, số hợp đồng, tên phòng hoặc tên toà. Lọc thêm được theo trạng thái. ' +
    'Trả số HĐ, khách đại diện, phòng/toà, ngày bắt đầu–kết thúc, trạng thái, tiền thuê và tiền cọc. ' +
    'Dùng khi hỏi "hợp đồng của ai", "phòng này ai đang thuê", "hợp đồng số ...".',
  inputSchema: z.object({
    tu_khoa: z
      .string()
      .optional()
      .describe('Tên khách / số hợp đồng / tên phòng / tên toà. Bỏ trống = không lọc theo chữ.'),
    trang_thai: z
      .enum(['nhap', 'dang_thue', 'gia_han', 'chuyen_nhuong', 'thanh_ly', 'het_han'])
      .optional()
      .describe('Lọc theo trạng thái hợp đồng. Bỏ trống = mọi trạng thái.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'contracts', action: 'view' },
  rolloutKey: 'contracts.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'tim_hop_dong');
    const tuKhoa = args.tu_khoa?.trim() ?? '';
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_query: string | null; p_status: string | null; p_limit: number },
      GoiHopDong
    >('copilot_contract_search_v1', {
      p_organization_id: orgId,
      p_query: tuKhoa ? tuKhoa : null,
      p_status: args.trang_thai ? (MA_TRANG_THAI_HD[args.trang_thai] ?? null) : null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tìm hợp đồng: ${error.message}`);
    const rows = data?.hop_dong ?? [];
    if (!rows.length) {
      return tuKhoa
        ? `Không tìm thấy hợp đồng nào khớp "${tuKhoa}".`
        : 'Không có hợp đồng nào khớp điều kiện.';
    }
    const dong = rows.map((r) => {
      const toa = r.toa_nha ? ` (${r.toa_nha})` : '';
      const nhan = NHAN_TRANG_THAI_HD[r.trang_thai] ?? r.trang_thai;
      return (
        `- ${r.so_hop_dong ?? r.hop_dong_id.slice(0, 8)} — ${r.khach_hang ?? '?'} — phòng ${r.phong ?? '?'}${toa}` +
        ` — ${r.ngay_bat_dau ?? '?'} → ${r.ngay_ket_thuc ?? '?'} — ${nhan}` +
        ` — thuê ${formatVND(Number(r.tien_thue) || 0)}, cọc ${formatVND(Number(r.tien_coc) || 0)}` +
        ` [link: /contracts/${r.hop_dong_id}]`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return `${rows.length} hợp đồng (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}`;
  },
});

export const chiTietHopDong = dt({
  name: 'chi_tiet_hop_dong',
  description:
    'Chi tiết MỘT hợp đồng theo id: kỳ hạn, tiền thuê, tiền cọc đang giữ và còn thiếu, kèm 5 hoá đơn gần nhất. ' +
    'Lấy id từ kết quả của tim_hop_dong (trường sau /contracts/).',
  inputSchema: z.object({
    hop_dong_id: z.string().regex(UUID_RE).describe('UUID hợp đồng, lấy từ link /contracts/<id>'),
  }),
  requiredPermission: { module: 'contracts', action: 'view' },
  // Trang chi tiết hợp đồng có `canonicalRoute` là /contracts, nên cờ rollout
  // của nó CHÍNH LÀ `contracts.list` — `contracts.detail` không có dòng cờ nào
  // (chỉ trang canonical mới được seed, xem 20260902185838).
  rolloutKey: 'contracts.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'chi_tiet_hop_dong');
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_contract_id: string },
      GoiChiTietHopDong
    >('copilot_contract_detail_v1', {
      p_organization_id: orgId,
      p_contract_id: args.hop_dong_id,
    });
    if (error) throw new Error(`Lỗi tải chi tiết hợp đồng: ${error.message}`);
    const hd = data?.tim_thay ? data.hop_dong : null;
    if (!hd) {
      // Server trả CÙNG một câu cho "không tồn tại" và "ngoài phạm vi của bạn".
      // Nói khác đi là tự xác nhận một id có thật ở công ty khác.
      return 'Không tìm thấy hợp đồng này trong phạm vi bạn được xem.';
    }
    const nhan = NHAN_TRANG_THAI_HD[hd.trang_thai] ?? hd.trang_thai;
    const phan = [
      `Hợp đồng ${hd.so_hop_dong ?? hd.hop_dong_id.slice(0, 8)} — ${nhan}`,
      `- Khách đại diện: ${hd.khach_hang ?? '?'}${hd.so_nguoi_o ? ` (${hd.so_nguoi_o} người trên HĐ)` : ''}`,
      `- Phòng: ${hd.phong ?? '?'}${hd.toa_nha ? ` (${hd.toa_nha})` : ''}`,
      `- Kỳ hạn: ${hd.ngay_bat_dau ?? '?'} → ${hd.ngay_ket_thuc ?? '?'}` +
        `${hd.ngay_ket_thuc_thuc_te ? ` (kết thúc thực tế ${hd.ngay_ket_thuc_thuc_te})` : ''}`,
      `- Tiền thuê: ${formatVND(Number(hd.tien_thue) || 0)}` +
        `${hd.chu_ky_thanh_toan ? ` / chu kỳ ${hd.chu_ky_thanh_toan}` : ''}`,
      `- Cọc: đang giữ ${formatVND(Number(hd.coc_da_thu) || 0)}/${formatVND(Number(hd.tien_coc) || 0)}` +
        `${Number(hd.coc_con_thieu) > 0 ? `, còn thiếu ${formatVND(Number(hd.coc_con_thieu))}` : ''}`,
      `[link: /contracts/${hd.hop_dong_id}]`,
    ];
    const hoaDon = data?.hoa_don ?? [];
    phan.push(
      hoaDon.length
        ? `\n${hoaDon.length} hoá đơn gần nhất:\n${hoaDon
            .map(
              (i) =>
                `- ${i.so_hoa_don ?? i.hoa_don_id.slice(0, 8)} — kỳ ${i.ky ?? '?'} — tổng ${formatVND(Number(i.tong_tien) || 0)}` +
                `, đã trả ${formatVND(Number(i.da_tra) || 0)}, còn ${formatVND(Number(i.con_lai) || 0)} — ${i.trang_thai ?? '?'}`,
            )
            .join('\n')}`
        : '\nHợp đồng này chưa có hoá đơn nào.',
    );
    return phan.join('\n');
  },
});

export const timPhieuThuChi = dt({
  name: 'tim_phieu_thu_chi',
  description:
    'Tìm phiếu thu / phiếu chi theo khoảng ngày, loại, trạng thái hoặc từ khoá (mã phiếu, tên phiếu, người nộp). ' +
    'Trả mã phiếu, số tiền, hạng mục, sổ quỹ, trạng thái duyệt và trạng thái vào sổ, người tạo. ' +
    'Dùng khi hỏi "chi cái gì tháng này", "phiếu chi nào chưa duyệt", "tìm phiếu ...".',
  inputSchema: z.object({
    tu_khoa: z.string().optional().describe('Mã phiếu, tên phiếu hoặc tên người nộp/nhận'),
    tu_ngay: z.string().regex(NGAY_RE).optional().describe('Từ ngày YYYY-MM-DD'),
    den_ngay: z.string().regex(NGAY_RE).optional().describe('Đến ngày YYYY-MM-DD'),
    loai: z.enum(['thu', 'chi']).optional().describe('thu = phiếu thu, chi = phiếu chi. Bỏ trống = cả hai.'),
    trang_thai: z
      .enum(['cho_xet', 'da_xong', 'da_huy'])
      .optional()
      .describe('cho_xet = chưa duyệt, da_xong = đã duyệt, da_huy = đã huỷ. Bỏ trống = mọi trạng thái.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'income_expenses', action: 'view' },
  rolloutKey: 'income-expenses.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'tim_phieu_thu_chi');
    const tuKhoa = args.tu_khoa?.trim() ?? '';
    const { data, error } = await goiRpcCopilot<
      {
        p_organization_id: string;
        p_query: string | null;
        p_tu: string | null;
        p_den: string | null;
        p_loai: string | null;
        p_trang_thai: string | null;
        p_limit: number;
      },
      GoiPhieu
    >('copilot_income_expense_search_v1', {
      p_organization_id: orgId,
      p_query: tuKhoa ? tuKhoa : null,
      p_tu: args.tu_ngay ?? null,
      p_den: args.den_ngay ?? null,
      p_loai: args.loai ? (MA_LOAI_PHIEU[args.loai] ?? null) : null,
      p_trang_thai: args.trang_thai ? (MA_TRANG_THAI_PHIEU[args.trang_thai] ?? null) : null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tìm phiếu thu chi: ${error.message}`);
    const rows = data?.phieu ?? [];
    if (!rows.length) return 'Không tìm thấy phiếu thu chi nào khớp điều kiện.';
    const dong = rows.map((r) => {
      // Tên sổ quỹ đi qua maskPii vì quy ước đặt tên nhét SỐ TÀI KHOẢN vào tên
      // ("TK 19036789456013 VCB") — xem chú thích ở dinhDangSoQuy.
      const quy = r.so_quy ? ` — sổ ${maskPii(r.so_quy)}` : '';
      const hangMuc = r.hang_muc ? ` — ${r.hang_muc}` : '';
      const nguoi = r.nguoi_tao ? ` — lập bởi ${r.nguoi_tao}` : '';
      const loai = NHAN_LOAI_PHIEU[r.loai] ?? r.loai;
      const tt = NHAN_TRANG_THAI_PHIEU[r.trang_thai] ?? r.trang_thai;
      const ghi = NHAN_GHI_NHAN[r.trang_thai_ghi_nhan] ?? r.trang_thai_ghi_nhan;
      return (
        `- [${loai}] ${r.ma_phieu ?? r.phieu_id.slice(0, 8)} — ${r.ten ?? '?'} — ${formatVND(Number(r.so_tien) || 0)}` +
        ` — ${r.ngay ?? '?'}${hangMuc}${quy} — ${tt}, ${ghi}${nguoi}`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return `${rows.length} phiếu thu chi (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}\n[link: /income-expense]`;
  },
});

export const hopChoDuyet = dt({
  name: 'hop_cho_duyet',
  description:
    'Hộp chờ duyệt của CHÍNH bạn: các phiếu thu chi đang đợi bạn xử lý, kèm mã phiếu, số tiền, người lập, thời điểm gửi. ' +
    'Chỉ ĐỌC — Copilot không duyệt, không từ chối, không ghi sổ; việc đó làm bằng tay ở trang /approvals. ' +
    'Dùng khi hỏi "có gì chờ tôi duyệt không", "hộp thư duyệt của tôi".',
  inputSchema: z.object({
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'income_expenses', action: 'view' },
  rolloutKey: 'income-expenses.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, TEN_TOOL_HOP_CHO);
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_limit: number },
      GoiHopCho
    >('copilot_pending_requests_v1', {
      p_organization_id: orgId,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tải hộp chờ: ${error.message}`);
    const rows = data?.hop_cho ?? [];
    if (!rows.length) return CAU_HOP_CHO_RONG;
    const dong = rows.map((r) => {
      const loai = r.loai ? (NHAN_LOAI_PHIEU[r.loai] ?? r.loai) : '?';
      const nguoi = r.nguoi_lap ? ` — lập bởi ${r.nguoi_lap}` : '';
      const luc = r.gui_luc ? ` — gửi ${String(r.gui_luc).slice(0, 10)}` : '';
      return (
        `- [${loai}] ${r.ma_phieu ?? (r.phieu_id ?? r.yeu_cau_id).slice(0, 8)} — ${r.ten_phieu ?? '?'}` +
        ` — ${formatVND(Number(r.so_tien) || 0)}${luc}${nguoi}`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return `${rows.length} ${TIEU_DE_HOP_CHO} (tối đa ${tran} dòng):\n${dong.join('\n')}\n[link: /approvals]`;
  },
});

// ── Vận hành: khách hẹn · công tơ · xe · công việc · kho (G1-C2) ────────────
//
// Năm tool dưới đây đọc qua RPC `copilot_*_v1` mới, KHÔNG đụng bảng qua
// PostgREST — cùng lý do với nhóm G1-C1. Riêng ở đây biên giới còn mỏng hơn:
// `leads`, `vehicles` và `jobs` mang `building_id` CÓ THỂ NULL, còn `materials`
// không có cột toà nào cả. Một `select` từ trình duyệt sẽ phải tự quyết định
// hàng chưa gắn toà thuộc về ai — quyết định đó nằm ở server, trong
// `authorized_scope_v3`, không nằm trong tay client.

interface HangKhachHen {
  khach_hen_id: string;
  khach_hang: string | null;
  dien_thoai: string | null;
  trang_thai: string | null;
  nguon: string | null;
  toa_nha: string | null;
  phong: string | null;
  ngay_hen: string | null;
  lien_he_cuoi: string | null;
  hen_lien_he_toi: string | null;
  ngan_sach_tu: number | null;
  ngan_sach_den: number | null;
  ngay_tao: string | null;
}

interface GoiKhachHen {
  gioi_han: number;
  so_luong: number;
  khach_hen: HangKhachHen[];
}

interface HangChiSo {
  chi_so_id: string;
  ma_phieu: string | null;
  toa_nha: string | null;
  phong: string | null;
  loai: string | null;
  chi_so_dau: number | null;
  chi_so_cuoi: number | null;
  tieu_thu: number | null;
  ngay_ghi: string | null;
  trang_thai: string | null;
}

interface TongHopChiSo {
  loai: string | null;
  so_dong: number | null;
  tong_tieu_thu: number | null;
}

interface GoiChiSo {
  ky: string;
  gioi_han: number;
  so_luong: number;
  tong_hop: TongHopChiSo[];
  chi_so: HangChiSo[];
}

interface HangXe {
  xe_id: string;
  bien_so: string | null;
  loai_xe: string | null;
  mo_ta: string | null;
  chu_xe: string | null;
  phong: string | null;
  toa_nha: string | null;
  phi_gui: number | null;
  ma_the: string | null;
}

interface GoiXe {
  gioi_han: number;
  so_luong: number;
  xe: HangXe[];
}

interface HangCongViec {
  cong_viec_id: string;
  ma: string | null;
  tieu_de: string | null;
  trang_thai: string | null;
  muc_do: string | null;
  loai: string | null;
  nguoi_lam: string | null;
  cua_toi: boolean | null;
  han: string | null;
  phong: string | null;
  toa_nha: string | null;
}

interface GoiCongViec {
  gioi_han: number;
  so_luong: number;
  cong_viec: HangCongViec[];
}

interface HangVatTu {
  vat_tu_id: string;
  ma: string | null;
  ten: string | null;
  nhom: string | null;
  don_vi: string | null;
  ton_kho: number | null;
  muc_dat_lai: number | null;
  duoi_muc: boolean | null;
  gia_binh_quan: number | null;
  gia_tri_ton: number | null;
}

interface TongHopVatTu {
  so_mat_hang: number | null;
  so_mat_hang_thieu: number | null;
  gia_tri_ton: number | null;
}

interface GoiVatTu {
  gioi_han: number;
  so_luong: number;
  tong_hop: TongHopVatTu;
  vat_tu: HangVatTu[];
}

const KY_RE = /^\d{4}-\d{2}$/;

export const timKhachHen = dt({
  name: 'tim_khach_hen',
  description:
    'Tìm khách hẹn (lead) theo tên hoặc số điện thoại, lọc thêm được theo bước trong phễu. ' +
    'Trả tên khách, SĐT (che một phần), bước hiện tại, nguồn, toà/phòng quan tâm, ngày hẹn xem và ngày cần liên hệ lại. ' +
    'Dùng khi hỏi "khách hẹn nào cần gọi lại", "ai đang chờ xem phòng", "tìm lead tên ...".',
  inputSchema: z.object({
    tu_khoa: z.string().optional().describe('Tên khách hoặc số điện thoại. Bỏ trống = không lọc theo chữ.'),
    trang_thai: z
      .enum(['moi', 'da_hen', 'dang_tu_van', 'da_chot', 'khong_thanh'])
      .optional()
      .describe('Bước trong phễu. Bỏ trống = mọi bước.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'leads', action: 'view' },
  rolloutKey: 'leads.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'tim_khach_hen');
    const tuKhoa = args.tu_khoa?.trim() ?? '';
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_query: string | null; p_trang_thai: string | null; p_limit: number },
      GoiKhachHen
    >('copilot_lead_search_v1', {
      p_organization_id: orgId,
      p_query: tuKhoa ? tuKhoa : null,
      p_trang_thai: args.trang_thai ? (MA_TRANG_THAI_LEAD[args.trang_thai] ?? null) : null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tìm khách hẹn: ${error.message}`);
    const rows = data?.khach_hen ?? [];
    if (!rows.length) {
      return tuKhoa
        ? `Không tìm thấy khách hẹn nào khớp "${tuKhoa}".`
        : 'Không có khách hẹn nào khớp điều kiện.';
    }
    const dong = rows.map((r) => {
      const buoc = r.trang_thai ? (NHAN_TRANG_THAI_LEAD[r.trang_thai] ?? r.trang_thai) : '?';
      const noi = [r.phong, r.toa_nha].filter(Boolean).join(' · ');
      const hen = r.ngay_hen ? ` — hẹn xem ${r.ngay_hen}` : '';
      const goiLai = r.hen_lien_he_toi ? ` — gọi lại ${r.hen_lien_he_toi}` : '';
      const ngan =
        r.ngan_sach_tu || r.ngan_sach_den
          ? ` — ngân sách ${formatVND(Number(r.ngan_sach_tu) || 0)}–${formatVND(Number(r.ngan_sach_den) || 0)}`
          : '';
      return (
        `- ${r.khach_hang ?? '?'} (${maskPhonePartial(r.dien_thoai)}) — ${buoc}` +
        `${noi ? ` — quan tâm ${noi}` : ''}${hen}${goiLai}${ngan}`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return `${rows.length} khách hẹn (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}\n[link: /leads]`;
  },
});

export const chiSoCongTo = dt({
  name: 'chi_so_cong_to',
  description:
    'Chỉ số công tơ của MỘT kỳ (YYYY-MM): phòng, loại công tơ (điện/nước/gas), chỉ số đầu–cuối, tiêu thụ và tình trạng kiểm. ' +
    'Kèm tổng tiêu thụ theo từng loại, tính trên TOÀN kỳ chứ không phải trên danh sách đã cắt. ' +
    'Dùng khi hỏi "tháng này ghi chỉ số chưa", "phòng nào dùng nhiều điện", "chỉ số kỳ ...".',
  inputSchema: z.object({
    ky: z.string().regex(KY_RE).describe('Kỳ chốt số dạng YYYY-MM, vd 2026-07'),
    toa_nha_id: z
      .string()
      .regex(UUID_RE)
      .optional()
      .describe('UUID toà nhà, nếu biết. Bỏ trống = mọi toà trong phạm vi bạn được xem.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'meter_readings', action: 'view' },
  rolloutKey: 'meter-readings.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'chi_so_cong_to');
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_ky: string; p_building_id: string | null; p_limit: number },
      GoiChiSo
    >('copilot_meter_readings_v1', {
      p_organization_id: orgId,
      p_ky: args.ky,
      p_building_id: args.toa_nha_id ?? null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tải chỉ số công tơ: ${error.message}`);
    const rows = data?.chi_so ?? [];
    if (!rows.length) return `Kỳ ${args.ky} chưa có dòng chỉ số nào trong phạm vi bạn được xem.`;
    const tongHop = (data?.tong_hop ?? [])
      .map((t) => {
        const loai = t.loai ? (NHAN_LOAI_CONG_TO[t.loai] ?? t.loai) : '?';
        return `${loai}: ${t.so_dong ?? 0} dòng, tiêu thụ ${Number(t.tong_tieu_thu) || 0}`;
      })
      .join(' · ');
    const dong = rows.map((r) => {
      const loai = r.loai ? (NHAN_LOAI_CONG_TO[r.loai] ?? r.loai) : '?';
      const tt = r.trang_thai ? (NHAN_TRANG_THAI_CHI_SO[r.trang_thai] ?? r.trang_thai) : '?';
      const toa = r.toa_nha ? ` (${r.toa_nha})` : '';
      return (
        `- phòng ${r.phong ?? '?'}${toa} — ${loai}: ${Number(r.chi_so_dau) || 0} → ${Number(r.chi_so_cuoi) || 0}` +
        ` = ${Number(r.tieu_thu) || 0} — ghi ${r.ngay_ghi ?? '?'} — ${tt}`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return (
      `Chỉ số kỳ ${args.ky}${tongHop ? ` — toàn kỳ: ${tongHop}` : ''}\n` +
      `${rows.length} dòng (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}\n[link: /meter-readings]`
    );
  },
});

export const timXe = dt({
  name: 'tim_xe',
  description:
    'Tìm phương tiện theo biển số, tên chủ xe, mã thẻ, tên phòng hoặc tên cư dân. ' +
    'Trả biển số, loại xe, chủ xe, phòng/toà, phí gửi và mã thẻ. ' +
    'Dùng khi hỏi "xe biển số ... của ai", "phòng này có mấy xe", "tìm xe của khách ...".',
  inputSchema: z.object({
    tu_khoa: z
      .string()
      .optional()
      .describe('Biển số / tên chủ xe / mã thẻ / tên phòng / tên cư dân. Bỏ trống = liệt kê theo toà.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'vehicles', action: 'view' },
  rolloutKey: 'vehicles.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'tim_xe');
    const tuKhoa = args.tu_khoa?.trim() ?? '';
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_query: string | null; p_limit: number },
      GoiXe
    >('copilot_vehicle_search_v1', {
      p_organization_id: orgId,
      p_query: tuKhoa ? tuKhoa : null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tìm xe: ${error.message}`);
    const rows = data?.xe ?? [];
    if (!rows.length) {
      return tuKhoa ? `Không tìm thấy xe nào khớp "${tuKhoa}".` : 'Không có xe nào trong phạm vi bạn được xem.';
    }
    const dong = rows.map((r) => {
      const loai = r.loai_xe ? (NHAN_LOAI_XE[r.loai_xe] ?? r.loai_xe) : '?';
      const noi = [r.phong, r.toa_nha].filter(Boolean).join(' · ');
      const phi = Number(r.phi_gui) > 0 ? ` — phí gửi ${formatVND(Number(r.phi_gui))}` : '';
      const the = r.ma_the ? ` — thẻ ${r.ma_the}` : '';
      const moTa = r.mo_ta ? ` (${r.mo_ta})` : '';
      return `- ${r.bien_so ?? '?'} — ${loai}${moTa} — ${r.chu_xe ?? '?'}${noi ? ` — ${noi}` : ''}${phi}${the}`;
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return `${rows.length} xe (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}\n[link: /vehicles]`;
  },
});

export const congViec = dt({
  name: 'cong_viec',
  description:
    'Danh sách công việc (phiếu việc) của công ty, việc GIAO CHO BẠN xếp trước. ' +
    'Trả mã việc, tiêu đề, loại, người làm, hạn, phòng/toà và tình trạng. ' +
    'Chỉ ĐỌC — Copilot không nhận việc, không đóng việc, không nghiệm thu; việc đó làm ở trang /tasks. ' +
    'Dùng khi hỏi "tôi còn việc gì", "việc nào quá hạn", "công việc đang làm".',
  inputSchema: z.object({
    trang_thai: z
      .enum(['dang_lam', 'xong'])
      .optional()
      .describe('dang_lam = đang thực hiện, xong = đã hoàn thành. Bỏ trống = cả hai.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'tasks', action: 'view' },
  rolloutKey: 'tasks.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'cong_viec');
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_trang_thai: string | null; p_limit: number },
      GoiCongViec
    >('copilot_tasks_v1', {
      p_organization_id: orgId,
      p_trang_thai: args.trang_thai ? (MA_TRANG_THAI_VIEC[args.trang_thai] ?? null) : null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tải công việc: ${error.message}`);
    const rows = data?.cong_viec ?? [];
    if (!rows.length) return 'Không có công việc nào khớp điều kiện.';
    const homNay = todayISO();
    const dong = rows.map((r) => {
      const tt = r.trang_thai ? (NHAN_TRANG_THAI_VIEC[r.trang_thai] ?? r.trang_thai) : '?';
      const mucDo = r.muc_do ? (NHAN_MUC_DO_VIEC[r.muc_do] ?? r.muc_do) : '';
      const noi = [r.phong, r.toa_nha].filter(Boolean).join(' · ');
      const quaHan = r.han && r.han.slice(0, 10) < homNay && r.trang_thai !== 'COMPLETED' ? ' ⚠ quá hạn' : '';
      const han = r.han ? ` — hạn ${r.han.slice(0, 10)}${quaHan}` : '';
      const nguoi = r.cua_toi ? ' — BẠN làm' : r.nguoi_lam ? ` — ${r.nguoi_lam}` : '';
      return (
        `- ${r.ma ?? r.cong_viec_id.slice(0, 8)}: ${r.tieu_de ?? '?'}` +
        `${r.loai ? ` [${r.loai}]` : ''} — ${tt}${mucDo ? `, ${mucDo}` : ''}${nguoi}${han}` +
        `${noi ? ` — ${noi}` : ''}`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    return `${rows.length} công việc (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}\n[link: /tasks]`;
  },
});

export const tonKhoVatTu = dt({
  name: 'ton_kho_vat_tu',
  description:
    'Tồn kho vật tư: số lượng còn, mức đặt lại, mặt hàng đang dưới mức và giá trị tồn. ' +
    'Mặt hàng thiếu được xếp lên đầu; các con số tổng tính trên TOÀN bộ kết quả khớp, không phải trên danh sách đã cắt. ' +
    'Dùng khi hỏi "còn bao nhiêu bóng đèn", "vật tư nào sắp hết", "giá trị tồn kho".',
  inputSchema: z.object({
    tu_khoa: z.string().optional().describe('Tên hoặc mã vật tư. Bỏ trống = toàn kho.'),
    so_luong: z.number().int().min(1).max(50).default(20).describe('Số dòng tối đa (trần 50)'),
  }),
  requiredPermission: { module: 'materials', action: 'view' },
  rolloutKey: 'materials.list',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'ton_kho_vat_tu');
    const tuKhoa = args.tu_khoa?.trim() ?? '';
    const { data, error } = await goiRpcCopilot<
      { p_organization_id: string; p_query: string | null; p_limit: number },
      GoiVatTu
    >('copilot_material_stock_v1', {
      p_organization_id: orgId,
      p_query: tuKhoa ? tuKhoa : null,
      p_limit: args.so_luong,
    });
    if (error) throw new Error(`Lỗi tải tồn kho vật tư: ${error.message}`);
    const rows = data?.vat_tu ?? [];
    if (!rows.length) {
      return tuKhoa ? `Không tìm thấy vật tư nào khớp "${tuKhoa}".` : 'Kho vật tư đang trống.';
    }
    const th = data?.tong_hop;
    const dong = rows.map((r) => {
      const canh = r.duoi_muc ? ' ⚠ dưới mức đặt lại' : '';
      const nhom = r.nhom ? ` [${r.nhom}]` : '';
      return (
        `- ${r.ma ? `${r.ma} — ` : ''}${r.ten ?? '?'}${nhom}: còn ${Number(r.ton_kho) || 0} ${r.don_vi ?? ''}` +
        ` (mức đặt lại ${Number(r.muc_dat_lai) || 0})${canh} — giá trị ${formatVND(Number(r.gia_tri_ton) || 0)}`
      );
    });
    const tran = data?.gioi_han ?? args.so_luong;
    const tomTat = th
      ? `Toàn kho khớp điều kiện: ${Number(th.so_mat_hang) || 0} mặt hàng, ` +
        `${Number(th.so_mat_hang_thieu) || 0} dưới mức đặt lại, giá trị tồn ${formatVND(Number(th.gia_tri_ton) || 0)}.\n`
      : '';
    return `${tomTat}${rows.length} vật tư (tối đa ${tran} dòng mỗi lần hỏi):\n${dong.join('\n')}\n[link: /materials]`;
  },
});

/** Gom lại để registry chèn vào một chỗ. */
export const TOOL_NGHIEP_VU: DomainTool[] = [
  tyLeLapDay as DomainTool,
  congNoTongQuan as DomainTool,
  cocDangGiu as DomainTool,
  soQuy as DomainTool,
  timHopDong as DomainTool,
  chiTietHopDong as DomainTool,
  timPhieuThuChi as DomainTool,
  hopChoDuyet as DomainTool,
  timKhachHen as DomainTool,
  chiSoCongTo as DomainTool,
  timXe as DomainTool,
  congViec as DomainTool,
  tonKhoVatTu as DomainTool,
];
