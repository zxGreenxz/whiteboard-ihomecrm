// Domain-tool registry DÙNG CHUNG cho chat (LLM class) + UI-control (PageAgent)
// — F7/F8 PLAN.md v2.1. Mỗi tool:
//   - requiredPermission: gate theo canUse (catalog fallback legacy) — check khi
//     BUILD danh sách tool (không đưa cho model) VÀ khi execute (double-check).
//   - execute chạy bằng supabase client phiên user → RLS là lớp chặn cuối.
//   - uiControlOnly: chỉ đưa vào adapter PageAgent (vd mo_trang — chat KHÔNG
//     điều hướng, chat trả link markdown để user tự click).
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import { canUse } from '@/lib/permissionPages';
import type { ActionKey, PermissionsMap } from '@/lib/permissions';
import { formatVND } from '@/lib/utils';
import { invoicesListQuery } from '@/hooks/useInvoices';
import { mapPayloadToBuildings, type RpcPayload } from '@/pages/phong-trong/supabaseData';
import { maskPhonePartial } from '../maskPii';
import { taoPhieuThuChiNhap } from './writeTools';

export interface ToolCtx {
  /** get_my_permissions() — undefined khi chưa load (mọi tool bị chặn). */
  perms: PermissionsMap | undefined;
  /** react-router navigate — chỉ adapter UI-control truyền vào. */
  navigate?: (to: string) => void;
}

export interface DomainTool<T = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  requiredPermission?: { module: string; action: ActionKey };
  uiControlOnly?: boolean;
  execute: (args: T, ctx: ToolCtx) => Promise<string>;
}

const dt = <T,>(t: DomainTool<T>): DomainTool<T> => t;

function assertPerm(tool: DomainTool, ctx: ToolCtx): void {
  if (!tool.requiredPermission) return;
  const { module, action } = tool.requiredPermission;
  if (!ctx.perms || !canUse(ctx.perms, module, action)) {
    throw new Error(`Không có quyền dùng công cụ "${tool.name}" (${module}.${action}).`);
  }
}

// ── Route whitelist cho mo_trang (route CANONICAL — /apartments, không /rooms) ──
export const MO_TRANG_ROUTES: Record<string, { route: string; module: string; label: string }> = {
  phong: { route: '/apartments', module: 'rooms', label: 'Căn hộ / Phòng' },
  hoa_don: { route: '/invoices', module: 'invoices', label: 'Hoá đơn' },
  khach_hang: { route: '/customers', module: 'customers', label: 'Cư dân' },
  hop_dong: { route: '/contracts', module: 'contracts', label: 'Hợp đồng' },
  toa_nha: { route: '/buildings', module: 'buildings', label: 'Toà nhà' },
};

// ── Docs hướng dẫn (lazy ?raw — không vào bundle chính) ──
const DOC_MODULES = import.meta.glob('/docs/he-thong/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

export function listDocTopics(): { key: string; path: string }[] {
  return Object.keys(DOC_MODULES).map((p) => ({
    key: p.replace(/^.*\//, '').replace(/\.md$/, ''),
    path: p,
  }));
}

// ── Tools ────────────────────────────────────────────────────────────────────
export function buildRegistry(): DomainTool[] {
  return [
    dt({
      name: 'phong_trong',
      description:
        'Danh sách phòng/căn hộ ĐANG TRỐNG theo từng toà (tên phòng, giá, diện tích, ngày trống). Dùng khi user hỏi phòng trống/còn phòng nào.',
      inputSchema: z.object({
        toa_nha: z.string().optional().describe('Lọc theo tên toà (khớp gần đúng), bỏ trống = tất cả'),
      }),
      requiredPermission: { module: 'rooms', action: 'view' },
      execute: async (args) => {
        const { data, error } = await (supabase.rpc as any)('get_my_available_rooms');
        if (error) throw new Error(`Lỗi tải phòng trống: ${error.message}`);
        let buildings = mapPayloadToBuildings((data as RpcPayload | null) ?? null);
        if (args.toa_nha) {
          const q = args.toa_nha.toLowerCase();
          buildings = buildings.filter((b) => b.name.toLowerCase().includes(q));
        }
        // Building.rooms = TẤT CẢ phòng (phục vụ layout sale) — phòng trống
        // thật là status 'free', sắp trống là 'soon' (đừng đếm rented/pass).
        const fmt = (r: { code: string; price: number; area: number; floor: number; availDate: string | null }) =>
          `  - ${r.code}: ${r.price} triệu/tháng, ${r.area}m², tầng ${r.floor}${r.availDate ? `, trống từ ${r.availDate}` : ''}`;
        const lines: string[] = [];
        let totalFree = 0;
        for (const b of buildings) {
          const free = b.rooms.filter((r) => r.status === 'free');
          const soon = b.rooms.filter((r) => r.status === 'soon');
          if (!free.length && !soon.length) continue;
          totalFree += free.length;
          const parts = [`${b.name} (${b.address}):`];
          if (free.length) parts.push(`  Trống ngay (${free.length}):\n${free.map(fmt).join('\n')}`);
          if (soon.length) parts.push(`  Sắp trống (${soon.length}):\n${soon.map(fmt).join('\n')}`);
          lines.push(parts.join('\n'));
        }
        if (!lines.length) return 'Hiện không có phòng trống nào.';
        return `Tổng ${totalFree} phòng trống ngay.\n\n${lines.join('\n\n')}`;
      },
    }),

    dt({
      name: 'tim_khach_hang',
      description: 'Tìm khách hàng/cư dân theo tên hoặc SĐT. Trả về tên, SĐT (che một phần), phòng đang thuê.',
      inputSchema: z.object({ tu_khoa: z.string().min(1).describe('Tên hoặc SĐT') }),
      requiredPermission: { module: 'customers', action: 'view' },
      execute: async (args) => {
        const kw = args.tu_khoa.trim();
        const { data, error } = await supabase
          .from('customers')
          .select('id, full_name, phone, room:rooms(name), building:buildings(name)')
          .is('deleted_at', null)
          .or(`full_name.ilike.%${kw}%,phone.ilike.%${kw}%`)
          .limit(10);
        if (error) throw new Error(`Lỗi tìm khách hàng: ${error.message}`);
        if (!data?.length) return `Không tìm thấy khách hàng nào khớp "${kw}".`;
        // Field allowlist + mask SĐT một phần (KHÔNG trả CCCD/STK)
        return data
          .map((c: any) => {
            const room = c.room?.name ? ` — phòng ${c.room.name}${c.building?.name ? ` (${c.building.name})` : ''}` : '';
            return `- ${c.full_name} — ${maskPhonePartial(c.phone)}${room} [link: /customers/${c.id}]`;
          })
          .join('\n');
      },
    }),

    dt({
      name: 'tim_hoa_don',
      description:
        'Tìm hoá đơn theo tháng (YYYY-MM), trạng thái thanh toán, hoặc tên khách/số HĐ. Trả tối đa 10 kết quả.',
      inputSchema: z.object({
        thang: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Kỳ YYYY-MM'),
        trang_thai: z.enum(['paid', 'unpaid', 'partial']).optional().describe('paid=đã thu đủ, unpaid=chưa thu, partial=thu một phần'),
        tu_khoa: z.string().optional().describe('Tên khách hoặc số hoá đơn'),
      }),
      requiredPermission: { module: 'invoices', action: 'view' },
      execute: async (args) => {
        // Tái dùng factory (lọc kind/deleted/sort chuẩn — PLAN §2.2)
        const q = invoicesListQuery(
          { billing_month: args.thang, payment_status: args.trang_thai, search: args.tu_khoa },
          { page: 1, pageSize: 10 },
        );
        const result = await (q.queryFn as () => Promise<any>)();
        const rows = result?.data ?? [];
        if (!rows.length) return 'Không tìm thấy hoá đơn nào khớp điều kiện.';
        const lines = rows.map((inv: any) => {
          const room = inv.room?.name ?? '?';
          const building = inv.building?.name ?? '';
          return `- HĐ ${inv.invoice_number ?? inv.id.slice(0, 8)} — phòng ${room}${building ? ` (${building})` : ''} — kỳ ${inv.billing_month} — tổng ${formatVND(inv.total_amount)} — trạng thái ${inv.status}`;
        });
        return `Tìm thấy ${result.count ?? rows.length} hoá đơn (hiện 10 đầu):\n${lines.join('\n')}`;
      },
    }),

    dt({
      name: 'hop_dong_sap_het_han',
      description: 'Danh sách hợp đồng sắp hết hạn trong N ngày tới (mặc định 30).',
      inputSchema: z.object({
        so_ngay: z.number().int().min(1).max(365).default(30).describe('Số ngày tới'),
      }),
      requiredPermission: { module: 'reports_real_estate', action: 'expiring' },
      execute: async (args) => {
        const today = new Date();
        const until = new Date(today.getTime() + args.so_ngay * 86_400_000);
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        const { data, error } = await supabase
          .from('contracts')
          .select('id, contract_number, end_date, room:rooms(name), building:buildings(name), customer:customers(full_name)')
          .eq('status', 'ACTIVE')
          .is('deleted_at', null)
          .gte('end_date', iso(today))
          .lte('end_date', iso(until))
          .order('end_date', { ascending: true })
          .limit(30);
        if (error) throw new Error(`Lỗi tải hợp đồng: ${error.message}`);
        if (!data?.length) return `Không có hợp đồng nào hết hạn trong ${args.so_ngay} ngày tới.`;
        const lines = data.map((c: any) =>
          `- ${c.contract_number ?? c.id.slice(0, 8)} — ${c.customer?.full_name ?? '?'} — phòng ${c.room?.name ?? '?'}${c.building?.name ? ` (${c.building.name})` : ''} — hết hạn ${c.end_date} [link: /contracts/${c.id}]`,
        );
        return `${data.length} hợp đồng hết hạn trong ${args.so_ngay} ngày tới:\n${lines.join('\n')}`;
      },
    }),

    dt({
      name: 'doanh_thu_thang',
      description:
        'Doanh thu / chi phí / lợi nhuận KQKD theo tháng, theo từng toà (nguồn fa_monthly_pnl — cùng số với trang Phân tích tài chính).',
      inputSchema: z.object({
        thang: z.string().regex(/^\d{4}-\d{2}$/).describe('Tháng YYYY-MM'),
        accrual: z.boolean().default(false).describe('true = dồn tích (accrual), false = tiền mặt'),
      }),
      requiredPermission: { module: 'reports_finance', action: 'analysis' },
      execute: async (args) => {
        const [y, m] = args.thang.split('-').map(Number);
        const start = `${args.thang}-01`;
        const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // ngày cuối tháng
        const fn = args.accrual ? 'fa_monthly_pnl_accrual' : 'fa_monthly_pnl';
        const { data, error } = await (supabase.rpc as any)(fn, {
          p_start_date: start,
          p_end_date: end,
          p_building_ids: null,
        });
        if (error) throw new Error(`Lỗi tải P&L: ${error.message}`);
        const rows = (data ?? []) as any[];
        if (!rows.length) return `Không có dữ liệu KQKD tháng ${args.thang}.`;
        let rev = 0, exp = 0;
        const lines = rows.map((r) => {
          rev += Number(r.revenue) || 0;
          exp += Number(r.expense) || 0;
          return `- ${r.building_name}: thu ${formatVND(Number(r.revenue) || 0)}, chi ${formatVND(Number(r.expense) || 0)}, ròng ${formatVND(Number(r.net) || 0)}`;
        });
        return [
          `KQKD tháng ${args.thang} (${args.accrual ? 'dồn tích' : 'tiền mặt'}):`,
          `TỔNG: doanh thu ${formatVND(rev)}, chi phí ${formatVND(exp)}, lợi nhuận ${formatVND(rev - exp)}`,
          ...lines,
        ].join('\n');
      },
    }),

    dt({
      name: 'huong_dan',
      description:
        'Tra cứu tài liệu hướng dẫn nghiệp vụ hệ thống (hợp đồng, hoá đơn, thu chi, cọc, thanh lý…). Trả nội dung tài liệu khớp chủ đề.',
      inputSchema: z.object({ chu_de: z.string().min(2).describe('Chủ đề cần tra, vd "hoá đơn", "thanh lý"') }),
      execute: async (args) => {
        const topics = listDocTopics();
        const norm = (s: string) =>
          s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
        const q = norm(args.chu_de);
        const hit = topics.find((t) => norm(t.key).includes(q.replace(/\s+/g, '-')))
          ?? topics.find((t) => q.split(/\s+/).every((w) => norm(t.key).includes(w)));
        if (!hit) {
          return `Không tìm thấy tài liệu cho "${args.chu_de}". Danh sách chủ đề: ${topics.map((t) => t.key).join(', ')}`;
        }
        const content = await DOC_MODULES[hit.path]();
        return `Tài liệu "${hit.key}":\n${content.slice(0, 8000)}${content.length > 8000 ? '\n…(cắt bớt)' : ''}`;
      },
    }),

    // Write tool draft-first (Phase 5): NHÁP + 2 bước xác nhận + idempotency
    taoPhieuThuChiNhap,

    dt({
      name: 'mo_trang',
      description:
        'Điều hướng người dùng tới một trang trong ứng dụng. CHỈ dùng các trang: phong, hoa_don, khach_hang, hop_dong, toa_nha.',
      inputSchema: z.object({
        trang: z.enum(['phong', 'hoa_don', 'khach_hang', 'hop_dong', 'toa_nha']),
      }),
      uiControlOnly: true, // chat KHÔNG điều hướng — trả link để user click
      execute: async (args, ctx) => {
        const target = MO_TRANG_ROUTES[args.trang];
        if (!target) throw new Error(`Trang "${args.trang}" không nằm trong whitelist.`);
        if (!ctx.perms || !canUse(ctx.perms, target.module, 'view')) {
          throw new Error(`Không có quyền xem trang ${target.label}.`);
        }
        if (!ctx.navigate) throw new Error('Thiếu navigate — tool này chỉ dùng trong UI-control.');
        ctx.navigate(target.route);
        return `✅ Đã mở trang ${target.label} (${target.route}).`;
      },
    }),
  ];
}

// ── Adapters ─────────────────────────────────────────────────────────────────

/** Tool cho chat loop (LLM class @page-agent/llms): bỏ uiControlOnly, lọc theo quyền. */
export function toLlmTools(
  registry: DomainTool[],
  ctx: ToolCtx,
): Record<string, { description: string; inputSchema: z.ZodType<any>; execute: (args: any) => Promise<string> }> {
  const out: Record<string, { description: string; inputSchema: z.ZodType<any>; execute: (args: any) => Promise<string> }> = {};
  for (const tool of registry) {
    if (tool.uiControlOnly) continue;
    if (tool.requiredPermission && (!ctx.perms || !canUse(ctx.perms, tool.requiredPermission.module, tool.requiredPermission.action))) {
      continue; // không đưa cho model tool mà user không có quyền
    }
    out[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args: any) => {
        assertPerm(tool, ctx);
        return tool.execute(args, ctx);
      },
    };
  }
  return out;
}

/** Tool cho PageAgent (UI-control): gồm cả mo_trang; execute bọc this-context. */
export function toPageAgentTools(
  registry: DomainTool[],
  ctx: ToolCtx,
): Record<string, { description: string; inputSchema: z.ZodType<any>; execute: (this: unknown, args: any, toolCtx: { signal: AbortSignal }) => Promise<string> }> {
  const out: Record<string, { description: string; inputSchema: z.ZodType<any>; execute: (this: unknown, args: any, toolCtx: { signal: AbortSignal }) => Promise<string> }> = {};
  for (const tool of registry) {
    if (tool.requiredPermission && (!ctx.perms || !canUse(ctx.perms, tool.requiredPermission.module, tool.requiredPermission.action))) {
      continue;
    }
    out[tool.name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      async execute(args: any) {
        assertPerm(tool, ctx);
        return tool.execute(args, ctx);
      },
    };
  }
  return out;
}
