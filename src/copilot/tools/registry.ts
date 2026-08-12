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
  /**
   * Tool GHI dữ liệu — chỉ đưa cho chat, KHÔNG đưa cho PageAgent (UI-control).
   *
   * Vì sao phải có cờ này thay vì tin vào prompt: UI-control là chế độ thí điểm
   * "chỉ điều hướng + lọc + điền form, không bấm Lưu". Nhưng adapter của nó
   * trước đây cấp NGUYÊN bộ registry, nên agent thao tác giao diện vẫn cầm
   * `tao_phieu_thu_chi_nhap` — tức là có một đường ghi thẳng vào DB, đi vòng
   * qua đúng cái quy tắc mà cả `safetyGuard` lẫn prompt đang canh ở tầng DOM.
   * Chặn nút Lưu trên màn hình mà vẫn phát chìa khoá cửa sau thì việc chặn đó
   * không còn nghĩa gì.
   */
  chatOnly?: boolean;
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
//
// MỘT nguồn, ba thứ dẫn xuất. Trước 11/08/2026 danh sách trang này được viết
// BỐN lần: khoá của map, `z.enum` của inputSchema, câu `description` gửi cho mô
// hình, và luật kiểm lúc chạy. Bốn bản chép của một danh sách thì bản nào lệch
// cũng hỏng theo kiểu riêng — `z.enum` lệch thì tool từ chối một trang có thật,
// còn `description` lệch thì mô hình không bao giờ gọi tới trang mới thêm.
// Nay `z.enum` và `description` đều SINH TỪ map; `scripts/check-copilot-routes.mjs`
// canh nốt hai thứ không suy ra được từ đây: route có tồn tại thật không, và
// module có phải module quyền thật không.
export const MO_TRANG_ROUTES: Record<string, { route: string; module: string; label: string }> = {
  phong: { route: '/apartments', module: 'rooms', label: 'Căn hộ / Phòng' },
  hoa_don: { route: '/invoices', module: 'invoices', label: 'Hoá đơn' },
  khach_hang: { route: '/customers', module: 'customers', label: 'Cư dân' },
  hop_dong: { route: '/contracts', module: 'contracts', label: 'Hợp đồng' },
  toa_nha: { route: '/buildings', module: 'buildings', label: 'Toà nhà' },
};

/** Khoá của whitelist, dạng tuple để `z.enum` nhận — KHÔNG khai lại bằng tay. */
const MO_TRANG_KEYS = Object.keys(MO_TRANG_ROUTES) as [string, ...string[]];

// ── Docs hướng dẫn (lazy ?raw — không vào bundle chính) ──
//
// Glob CHỈ để nạp nội dung; file nào được Copilot đọc thì do
// docs/he-thong/manifest.json quyết định. Trước đây glob này là allowlist luôn,
// nghĩa là mọi .md ai đó thả vào thư mục đều lập tức thành nguồn tư vấn nghiệp
// vụ cho người dùng thật — kể cả writeup hiệu năng nội bộ hay bản đồ realtime
// dành cho lập trình viên. Gate: scripts/check-copilot-docs-manifest.mjs.
const DOC_MODULES = import.meta.glob('/docs/he-thong/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const DOC_MANIFESTS = import.meta.glob('/docs/he-thong/manifest.json', {
  eager: true,
  import: 'default',
}) as Record<string, DocsManifest>;

interface DocsManifestEntry {
  file: string;
  copilotIngest: boolean;
  reviewed?: string | null;
  requiredPermission?: { module: string; action: ActionKey };
  why?: string;
}
interface DocsManifest {
  schemaVersion: number;
  staleAfterDays?: number;
  entries: DocsManifestEntry[];
}

const DOCS_MANIFEST: DocsManifest =
  DOC_MANIFESTS['/docs/he-thong/manifest.json'] ?? { schemaVersion: 0, entries: [] };

export interface DocTopic {
  key: string;
  path: string;
  requiredPermission?: { module: string; action: ActionKey };
}

/**
 * Nạp nội dung một tài liệu theo đường dẫn glob. Trả `null` nếu đường dẫn không
 * thuộc glob.
 *
 * Đây là ĐƯỜNG NẠP DUY NHẤT, và nó cố ý nằm cùng file với phép lọc manifest ở
 * `listDocTopics`. Người gọi (hiện là `docs/docSearch.ts`) phải tự lọc trước
 * bằng `listDocTopics`; hàm này không tự kiểm quyền vì nó không biết quyền —
 * gộp hai trách nhiệm vào một chỗ sẽ khiến cả hai khó kiểm hơn.
 *
 * Vì sao không để mỗi nơi tự `import.meta.glob`: có hai đường nạp thì tồn tại
 * khả năng một đường đi vòng qua allowlist, và cửa chặn không còn chứng minh
 * được điều gì.
 */
export async function napTaiLieu(path: string): Promise<string | null> {
  const nap = DOC_MODULES[path];
  return nap ? await nap() : null;
}

/**
 * Dấu review còn hiệu lực không?
 *
 * `reviewed` KHÔNG khai ⇒ coi là còn dùng được. Đây là lựa chọn có chủ đích, không
 * phải lỗ hổng: 12 trong 25 tài liệu Copilot đang đọc chưa từng ghi ngày review
 * (đo 11/08/2026), và loại hết chúng ở runtime sẽ cắt hơn một nửa kiến thức của
 * Copilot trong im lặng. Món nợ đó được khai tường minh ở `unreviewedDebt` trong
 * manifest và có gate canh cho nó chỉ được teo đi.
 *
 * Ngày KHÔNG parse được cũng coi là còn hiệu lực: một chuỗi hỏng là lỗi dữ liệu,
 * và biến lỗi dữ liệu thành "im lặng bỏ tài liệu" là kiểu hỏng khó thấy nhất.
 * Gate manifest bắt chuỗi hỏng, đó mới là chỗ của nó.
 */
export function dauReviewConHieuLuc(
  reviewed: string | null | undefined,
  staleAfterDays: number | undefined,
  now: number,
): boolean {
  if (!reviewed || !staleAfterDays) return true;
  const moc = new Date(reviewed).getTime();
  if (Number.isNaN(moc)) return true;
  return (now - moc) / 86_400_000 <= staleAfterDays;
}

/**
 * Chủ đề tài liệu Copilot được phép đọc, đã lọc theo manifest VÀ quyền của phiên.
 *
 * `perms === undefined` (chưa load) ⇒ chỉ trả tài liệu không gắn quyền — fail
 * closed, giống assertPerm.
 *
 * Lọc thêm theo dấu review QUÁ HẠN. Đây là chỗ luật đó có răng thật: gate CI chỉ
 * cảnh báo (cố ý — xem chú thích trong check-copilot-docs-manifest.mjs: một gate
 * đỏ vì ngày tháng sẽ bị bump cho xong), còn ở đây tài liệu quá hạn thôi được nạp
 * và người dùng thấy Copilot mất kiến thức đó. Phản hồi ấy khó lờ hơn một dòng
 * cảnh báo trong log CI.
 *
 * Đo 11/08/2026: 0 tài liệu quá hạn, nên bật luật này KHÔNG đổi hành vi hôm nay —
 * nó chỉ chặn từ nay về sau.
 */
export function listDocTopics(perms?: PermissionsMap, now: number = Date.now()): DocTopic[] {
  const allowed = new Map(
    DOCS_MANIFEST.entries
      .filter((e) => e.copilotIngest)
      .filter((e) => dauReviewConHieuLuc(e.reviewed, DOCS_MANIFEST.staleAfterDays, now))
      .map((e) => [e.file, e]),
  );
  return Object.keys(DOC_MODULES)
    .map((path) => ({ path, file: path.replace(/^.*\//, '') }))
    .filter(({ file }) => allowed.has(file))
    .map(({ path, file }) => {
      const entry = allowed.get(file)!;
      return { key: file.replace(/\.md$/, ''), path, requiredPermission: entry.requiredPermission };
    })
    .filter((t) => {
      if (!t.requiredPermission) return true;
      const { module, action } = t.requiredPermission;
      return Boolean(perms && canUse(perms, module, action));
    });
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
        const { data, error } = await supabase.rpc('get_my_available_rooms');
        if (error) throw new Error(`Lỗi tải phòng trống: ${error.message}`);
        let buildings = mapPayloadToBuildings((data as unknown as RpcPayload | null) ?? null);
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
        // Đọc theo giờ LOCAL: toISOString() đổi sang UTC nên trước 7h sáng giờ VN
        // cả hai mốc lùi một ngày, và Copilot trả lời sai danh sách hợp đồng sắp
        // hết hạn — sai âm thầm, vì kết quả vẫn "có vẻ hợp lý".
        const iso = (d: Date) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
        // Hai lời gọi tên VIẾT THẲNG thay cho một biến `fn`: ba gate canh biên
        // RPC tìm tên bằng chuỗi viết thẳng, nên gói tên vào biến là giấu lời
        // gọi khỏi cả ba (xem `scripts/check-rpc-name-literal.mjs`).
        //
        // `p_building_ids` bỏ hẳn khoá: chữ ký live ghi `DEFAULT NULL::uuid[]`
        // nên vắng mặt cho ra đúng NULL như cũ, và khớp kiểu `?: string[]` mà bộ
        // sinh Supabase viết cho tham số có DEFAULT.
        const thamSo = { p_start_date: start, p_end_date: end };
        const { data, error } = args.accrual
          ? await supabase.rpc('fa_monthly_pnl_accrual', thamSo)
          : await supabase.rpc('fa_monthly_pnl', thamSo);
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
        'Tra cứu tài liệu nghiệp vụ hệ thống (hợp đồng, hoá đơn, thu chi, cọc, thanh lý, công tơ, lương…). Trả về các MỤC tài liệu liên quan nhất kèm nguồn. Hỏi bằng câu tự nhiên, không cần đoán tên file.',
      inputSchema: z.object({
        chu_de: z.string().min(2).describe('Câu hỏi hoặc chủ đề, vd "làm sao lấy lại tiền cọc"'),
        tai_lieu: z
          .string()
          .optional()
          .describe('Chỉ tìm trong một tài liệu (mã lấy từ liet_ke_chu_de), vd "16-thanh-ly-hop-dong"'),
      }),
      execute: async (args, ctx) => {
        // Trước 12/08/2026 tool này so khớp trên TÊN FILE rồi nạp nguyên tài
        // liệu, cắt 8000 ký tự ĐẦU. Với corpus 823KB / 25 file mà 20 file lớn
        // hơn 8KB, nghĩa là Copilot chỉ thấy phần mở đầu — và chỉ khi người
        // dùng gõ trúng slug tên file. Nay chunk theo heading và xếp hạng BM25.
        const { timTaiLieu, dinhDangChoModel } = await import('../docs/docSearch');
        const kq = await timTaiLieu(args.chu_de, ctx.perms, { chiTrongTaiLieu: args.tai_lieu });
        return dinhDangChoModel(kq);
      },
    }),

    dt({
      name: 'liet_ke_chu_de',
      description:
        'Liệt kê các tài liệu nghiệp vụ hiện có (mã và tiêu đề). Dùng khi huong_dan không tìm thấy, hoặc khi cần biết hệ thống có tài liệu về gì.',
      inputSchema: z.object({}),
      execute: async (_args, ctx) => {
        const topics = listDocTopics(ctx.perms);
        if (!topics.length) {
          return ctx.perms === undefined
            ? 'Đang tải quyền truy cập, chưa liệt kê được. Thử lại sau vài giây.'
            : 'Không có tài liệu nào bạn được phép đọc.';
        }
        return `Có ${topics.length} tài liệu:\n${topics.map((t) => `- ${t.key}`).join('\n')}`;
      },
    }),

    // Write tool draft-first (Phase 5): NHÁP + 2 bước xác nhận + idempotency
    taoPhieuThuChiNhap,

    dt({
      name: 'mo_trang',
      description:
        `Điều hướng người dùng tới một trang trong ứng dụng. CHỈ dùng các trang: ${MO_TRANG_KEYS.join(', ')}.`,
      inputSchema: z.object({
        trang: z.enum(MO_TRANG_KEYS),
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

/**
 * Tool cho PageAgent (UI-control): gồm cả mo_trang, nhưng KHÔNG gồm tool ghi.
 *
 * Đối xứng với `toLlmTools` bỏ `uiControlOnly`: ở đây bỏ `chatOnly`. Hai adapter
 * cùng một registry, mỗi bên khuyết đúng phần không thuộc về mình.
 */
export function toPageAgentTools(
  registry: DomainTool[],
  ctx: ToolCtx,
): Record<string, { description: string; inputSchema: z.ZodType<any>; execute: (this: unknown, args: any, toolCtx: { signal: AbortSignal }) => Promise<string> }> {
  const out: Record<string, { description: string; inputSchema: z.ZodType<any>; execute: (this: unknown, args: any, toolCtx: { signal: AbortSignal }) => Promise<string> }> = {};
  for (const tool of registry) {
    if (tool.chatOnly) continue;
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
