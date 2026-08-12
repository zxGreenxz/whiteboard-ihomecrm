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
import { maskPii } from '../maskPii';
import { todayISO } from '@/lib/collect';
import type { DomainTool } from './registry';

const dt = <T,>(t: DomainTool<T>): DomainTool<T> => t;

/** Ngày local dạng YYYY-MM-DD. KHÔNG dùng toISOString() — xem chú thích dưới. */
function ngayISO(d: Date): string {
  // `toISOString()` đổi sang UTC, nên trước 7h sáng giờ VN mọi mốc lùi một ngày
  // và báo cáo trả về sai kỳ một cách âm thầm — kết quả vẫn "trông hợp lý".
  // Repo đã dọn cả một lớp lỗi này (commit 11547392, f819c2a8); đừng tạo lại.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pct = (n: unknown) => `${(Number(n) || 0).toFixed(1)}%`;

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
  execute: async (args) => {
    const ngay = args.ngay ?? todayISO();
    const { data, error } = await supabase.rpc('occupancy_snapshot_v2', {
      p_as_of_date: ngay,
      // Bỏ khoá `p_building_ids` = server dùng DEFAULT NULL = mọi toà trong
      // quyền. Truyền `null` tường minh sẽ chặn file này khỏi đảo strict.
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
      const { data: sap, error: eSap } = await supabase.rpc('occupancy_upcoming_vacancy_v2', {
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
  execute: async (args) => {
    const { data, error } = await supabase.rpc('get_invoice_statistics_v2', {
      ...(args.thang ? { p_billing_month: args.thang } : {}),
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
  execute: async () => {
    const { data, error } = await supabase.rpc('get_held_deposit_summary', {});
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
  requiredPermission: { module: 'income_expenses', action: 'view' },
  execute: async (args) => {
    const nay = new Date();
    const tu = args.tu_ngay ?? ngayISO(new Date(nay.getFullYear(), nay.getMonth(), 1));
    const den = args.den_ngay ?? todayISO();
    const { data, error } = await supabase.rpc('cashbook_settlement_report', {
      p_from: tu,
      p_to: den,
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

/** Gom lại để registry chèn vào một chỗ. */
export const TOOL_NGHIEP_VU: DomainTool[] = [
  tyLeLapDay as DomainTool,
  congNoTongQuan as DomainTool,
  cocDangGiu as DomainTool,
  soQuy as DomainTool,
];
