// WRITE TOOL draft-first — xác nhận bằng NONCE do server phát.
//
// LUỒNG, và vì sao nó chia làm hai nửa không nối với nhau qua mô hình:
//
//   1. Mô hình gọi tool này với các trường NGHIỆP VỤ (không có cờ xác nhận nào).
//   2. Tool gọi `copilot_preview_income_expense_v1` — server chốt toà + hạng mục
//      trong công ty đang chọn, băm payload chuẩn hoá, phát nonce 32 byte.
//   3. Tool cất nonce vào `confirmationStore` (BỘ NHỚ) và trả về CHỈ bản xem
//      trước. Chuỗi trả về đi vào ngữ cảnh mô hình; nonce thì không.
//   4. Giao diện thấy có đề xuất đang chờ, vẽ thẻ xác nhận có nút bấm.
//   5. Người dùng bấm → giao diện gọi `copilot_execute_income_expense_v1` kèm
//      nonce. Mô hình không tham gia bước này.
//
// VÌ SAO KHÔNG CÒN `xac_nhan: boolean`
//   Cờ đó nằm trong input schema, nghĩa là chính mô hình quyết định khi nào
//   "người dùng đã đồng ý": gọi lần đầu `false`, đọc bản xem trước, gọi lại
//   `true`. Không có gì chứng minh giữa hai lần đó có một con người. Và dữ liệu
//   nghiệp vụ (ghi chú tự do, tên khách) đi thẳng vào ngữ cảnh mô hình, nên một
//   câu "xác nhận luôn giúp tôi" nằm trong ghi chú là đủ để nó tự lật cờ.
//
//   Bước 3 là chỗ ranh giới thật sự nằm: thứ mô hình sinh ra được là VĂN BẢN, và
//   văn bản không mở được cửa này.
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import type { ActionKey } from '@/lib/permissions';
import { formatVND } from '@/lib/utils';
import { chotToChuc, type DomainTool } from './registry';
import {
  ACTION_CATALOG,
  NHAN_TRUONG_XEM_TRUOC,
  SCHEMA_TAO_PHIEU_THU_CHI,
  khoaRolloutHanhDong,
  type ActionCatalogEntry,
  type ActionId,
} from '../plan/actionCatalog';
import { datXacNhanDangCho, layNguCanhXacNhan } from '../confirmationStore';

/** Hash chuỗi ổn định (djb2) — vẫn dùng cho khoá dedupe phía giao diện. */
export function makeIdempotencyKey(parts: (string | number)[]): string {
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `iek_${(h >>> 0).toString(36)}_${s.length}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function makeConfirmationIntentKey(
  organizationId: string,
  canonical: unknown,
  threadId?: string | null,
): string {
  return makeIdempotencyKey([
    'tao_phieu_thu_chi_nhap',
    organizationId,
    threadId ?? '',
    canonicalJson(canonical),
  ]);
}

/**
 * Chỉ dẫn kèm bản xem trước — thứ mô hình đọc đúng lúc sắp tạo phiếu thật.
 *
 * Tách thành hằng số để test soi được nội dung. Bản trước bảo mô hình "gọi
 * respond NGAY BÂY GIỜ", nhưng tool `respond` đã bị gỡ khi chat engine chuyển
 * sang `tool_choice: 'auto'` (xem chú thích đầu `chatEngine.ts`). Một chỉ dẫn
 * trỏ vào tool không tồn tại thì mô hình hoặc lờ đi, hoặc gọi rồi nhận lỗi —
 * cả hai đều làm hỏng đúng bước dừng-để-hỏi mà bản xem trước sinh ra để bảo vệ.
 */
export const TEXT_XEM_TRUOC_MAU =
  '⚠️ CHƯA TẠO. Người dùng sẽ thấy một thẻ xác nhận ngay dưới tin nhắn này và tự bấm nút để tạo. ' +
  'BƯỚC TIẾP THEO CỦA BẠN: trả lời thẳng bằng văn bản (không dùng thêm tool nào), nhắc lại ngắn gọn ' +
  'nội dung phiếu và mời họ kiểm tra rồi bấm nút. KHÔNG dùng lại tool này cho cùng một phiếu, và ' +
  'KHÔNG có cách nào để bạn tự xác nhận thay người dùng.';

/**
 * Schema input nằm ở `plan/actionCatalog.ts` — MỘT bản cho cả tool lẫn sổ đăng
 * ký hành động. Xem chú thích tại đó về lý do nó không ở lại file này.
 */
const inputSchema = SCHEMA_TAO_PHIEU_THU_CHI;

type Input = z.infer<typeof inputSchema>;


/** Hình dạng server trả về ở bước xem trước. */
interface KetQuaXemTruoc {
  confirmation_nonce: string;
  canonical: unknown;
  preview: {
    loai: string;
    so_tien: number;
    ten_phieu: string;
    toa_nha: string;
    hang_muc: string;
    ngay: string;
    trang_thai: string;
  };
}

/** Lỗi nghiệp vụ từ RPC → câu tiếng Việt mô hình đọc và thuật lại được. */
const GIAI_THICH_LOI: Record<string, string> = {
  organization_required: 'Chưa chọn công ty. Bảo người dùng chọn công ty ở nhãn trên thanh đầu trang.',
  not_permitted: 'Người dùng không có quyền tạo phiếu thu/chi trong công ty đang chọn.',
  loai_khong_hop_le: 'Loại phiếu phải là "thu" hoặc "chi".',
  so_tien_khong_hop_le: 'Số tiền phải là số dương.',
  ten_phieu_qua_ngan: 'Tên phiếu quá ngắn (cần ít nhất 3 ký tự).',
  toa_nha_khong_thay: 'Không tìm thấy toà nhà nào khớp trong công ty đang chọn. Hỏi lại tên toà chính xác.',
  toa_nha_mo_ho: 'Có nhiều toà cùng khớp tên đó. Hỏi người dùng chọn toà nào rồi gọi lại với tên chính xác.',
  hang_muc_khong_thay: 'Không tìm thấy hạng mục nào khớp. Hỏi lại tên hạng mục chính xác.',
  hang_muc_mo_ho: 'Có nhiều hạng mục cùng khớp. Hỏi người dùng chọn hạng mục nào rồi gọi lại.',
};

function dienGiaiLoi(message: string): string {
  for (const [ma, cau] of Object.entries(GIAI_THICH_LOI)) {
    if (message.includes(ma)) return cau;
  }
  return `Lỗi khi lập phiếu: ${message}`;
}

export const taoPhieuThuChiNhap: DomainTool<Input> = {
  name: 'tao_phieu_thu_chi_nhap',
  description:
    'Lập ĐỀ XUẤT phiếu thu/chi để người dùng xác nhận. Tool này KHÔNG tạo phiếu: nó chỉ dựng bản xem ' +
    'trước và hiện một thẻ xác nhận cho người dùng bấm. Phiếu tạo ra sau đó là bản CHỜ DUYỆT, chưa vào sổ quỹ.',
  inputSchema,
  requiredPermission: { module: 'income_expenses', action: 'create' },
  // Chat mới được cầm tool này. UI-control (PageAgent) thì KHÔNG — xem chú
  // thích `chatOnly` ở DomainTool.
  chatOnly: true,
  // CÔNG TẮC THẬT, KHÔNG CÒN MIỄN TRỪ.
  //
  // Trước G2-B tool này `rolloutExempt: true` với lý do "đã có nonce + cú bấm
  // người dùng". Hai lớp đó bảo vệ MỘT lần ghi; chúng không cho ai một cách tắt
  // đường ghi khi đang có sự cố. Kill switch là câu hỏi khác — "dừng ngay bây
  // giờ" — và câu đó chỉ trả lời được bằng một hàng cờ mà server sở hữu.
  //
  // Hàng `('action','income_expense.create_draft')` seed ở migration
  // `20260903043956` với trạng thái `disabled`. Nghĩa là ngay sau khi bản này
  // lên, tool KHÔNG xuất hiện trong danh sách gửi cho mô hình cho tới khi một
  // super admin bật nó ở tab Rollout. Đó là hành vi đúng của một kill switch,
  // không phải hồi quy.
  rolloutKey: khoaRolloutHanhDong('income_expense.create_draft'),
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'tao_phieu_thu_chi_nhap');
    const threadId = ctx.threadId ?? null;

    const { data, error } = await supabase.rpc('copilot_preview_income_expense_v1', {
      p_organization_id: orgId,
      p_payload: {
        loai: args.loai,
        so_tien: args.so_tien,
        ten_phieu: args.ten_phieu,
        toa_nha: args.toa_nha,
        hang_muc: args.hang_muc,
        ...(args.ngay ? { ngay: args.ngay } : {}),
      },
    });
    if (error) return dienGiaiLoi(error.message ?? String(error));

    const kq = data as unknown as KetQuaXemTruoc | null;
    if (!kq?.confirmation_nonce) {
      throw new Error('Server không trả về mã xác nhận — không lập được đề xuất.');
    }

    // Nonce rẽ sang bộ nhớ cho giao diện; KHÔNG đi vào chuỗi trả về.
    datXacNhanDangCho({
      tool: 'income_expense.create_draft',
      nonce: kq.confirmation_nonce,
      canonical: kq.canonical,
      preview: kq.preview as unknown as Record<string, unknown>,
      organizationId: orgId,
      threadId,
      generation: ctx.generation,
      intentKey: makeConfirmationIntentKey(orgId, kq.canonical, threadId),
    });

    const p = kq.preview;
    const banXemTruoc =
      `PHIẾU ${p.loai} CHỜ XÁC NHẬN:\n` +
      `- Tên: ${p.ten_phieu}\n` +
      `- Số tiền: ${formatVND(p.so_tien)}\n` +
      `- Toà: ${p.toa_nha}\n` +
      `- Hạng mục: ${p.hang_muc}\n` +
      `- Ngày: ${p.ngay}\n` +
      `- Trạng thái sau khi tạo: ${p.trang_thai} (chưa duyệt, chưa vào sổ)`;

    return `${banXemTruoc}\n\n${TEXT_XEM_TRUOC_MAU}`;
  },
};

/**
 * Thực thi đề xuất đang chờ. CHỈ giao diện gọi, sau một cú bấm thật.
 *
 * Không nằm trong registry: nếu nó là một `DomainTool` thì mô hình gọi được, và
 * cả kiến trúc nonce sụp — mô hình sẽ tự bấm nút của chính mình.
 */
export interface ConfirmationExecutionContext {
  organizationId: string | null;
  threadId: string | null;
  generation?: number;
}

export async function thucThiXacNhan(
  nonce: string,
  canonical: unknown,
  expectedContext: ConfirmationExecutionContext,
): Promise<string> {
  const current = layNguCanhXacNhan();
  if (
    !current ||
    current.organizationId !== expectedContext.organizationId ||
    current.threadId !== expectedContext.threadId ||
    (expectedContext.generation !== undefined && current.generation !== expectedContext.generation)
  ) {
    throw new Error('confirmation_scope_mismatch: organization or conversation changed');
  }
  const { data, error } = await supabase.rpc('copilot_execute_income_expense_v1', {
    p_confirmation_nonce: nonce,
    // `Json` của generated types, không phải `Record<string, unknown>`: payload
    // này đi NGUYÊN VẸN từ preview sang execute và server băm nó để so. Ép sang
    // một kiểu rộng hơn ở đây là mở đường cho ai đó sửa nó giữa đường mà trình
    // biên dịch không nói gì — mà sửa nó chính là thứ phép so hash tồn tại để bắt.
    p_payload: canonical as Json,
  });
  if (error) {
    const m = error.message ?? String(error);
    if (m.includes('confirmation_expired')) {
      return '⏱️ Đề xuất đã quá hạn (5 phút). Hãy yêu cầu Copilot lập lại phiếu.';
    }
    if (m.includes('confirmation_already_used')) {
      return '⚠️ Đề xuất này đã được dùng rồi — không tạo trùng.';
    }
    if (m.includes('payload_changed')) {
      return '⚠️ Nội dung phiếu đã thay đổi sau khi xem trước. Hãy lập lại đề xuất.';
    }
    if (m.includes('confirmation_not_found') || m.includes('confirmation_required')) {
      return '⚠️ Không tìm thấy đề xuất hợp lệ. Hãy yêu cầu Copilot lập lại phiếu.';
    }
    throw new Error(`Lỗi tạo phiếu: ${m}`);
  }

  const kq = data as unknown as { status?: string; entity_id?: string } | null;
  if (kq?.status === 'da_tao_truoc_do') {
    return '⚠️ Phiếu này đã được tạo trước đó — không tạo trùng. Xem tại [Thu chi](/income-expense).';
  }
  const id = kq?.entity_id;
  if (!id) throw new Error('Server không trả về id phiếu.');

  // Đọc lại mã phiếu (read-only) để câu thông báo có thứ người dùng tra cứu được.
  const { data: codeRow } = await supabase
    .from('income_expenses')
    .select('code')
    .eq('id', id)
    .maybeSingle();
  const code = (codeRow as { code?: string } | null)?.code ?? id.slice(0, 8);
  return `✅ Đã tạo phiếu CHỜ DUYỆT ${code}. Phiếu chưa duyệt, chưa vào sổ; kiểm tra và duyệt tại [Thu chi](/income-expense).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL GHI SINH TỪ SỔ HÀNH ĐỘNG (G2-D)
// ─────────────────────────────────────────────────────────────────────────────
//
// Ba action L3 dưới đây dùng CHUNG một thân `execute`: gọi RPC xem trước của
// `ACTION_CATALOG`, cất nonce vào `confirmationStore`, trả về CHỈ bản xem trước.
// Không dòng nào trong đó phụ thuộc vào hành động cụ thể, nên viết ba lần là ba
// cơ hội để chúng lệch nhau — và cái lệch ở đây là cái lệch về BẢO MẬT (một bản
// quên `chotToChuc`, một bản lỡ đưa nonce vào chuỗi trả về).
//
// VÌ SAO VẪN CÓ MỘT BẢNG KHAI BÁO CHỮ CHẾT BÊN CẠNH FACTORY
//   `scripts/check-copilot-tool-inventory.mjs` và
//   `scripts/check-copilot-forbidden-actions.mjs` đọc file này bằng REGEX (chúng
//   không import được: `registry.ts` kéo theo supabase client và hook React).
//   Cả hai coi mỗi `name: '...'` là một tool và đọc `chatOnly` /
//   `requiredPermission` trong khối văn bản từ đó tới `name:` kế tiếp.
//
//   Một factory thuần — `ACTION_CATALOG` vào, `DomainTool` ra — sẽ không để lại
//   một chữ `name:` nào trong file. Hệ quả không phải là gate đỏ mà là gate XANH
//   trong khi tài liệu kể một con số tool nhỏ hơn registry thật, và cửa cấm
//   không soi thân `execute` của ba đường ghi mới. Đúng loại drift mà hai gate
//   đó sinh ra để chặn, chỉ là ở chính chúng.
//
//   Nên bảng dưới đây khai chữ chết đúng ba trường mà hai bộ đọc cần, và
//   factory DÙNG chúng (không có trường nào bị bỏ qua). Việc `requiredPermission`
//   ở đây phải khớp `permission` trong `ACTION_CATALOG` do
//   `writeToolsHanhDong.test.ts` canh — lệch một chữ là đỏ.

/** Một dòng khai báo tool ghi: phần mà hai gate regex phải đọc thấy. */
interface KhaiBaoToolGhi {
  name: string;
  description: string;
  chatOnly: true;
  requiredPermission: { module: string; action: ActionKey };
  actionId: ActionId;
}

const KHAI_BAO_TOOL_GHI: readonly KhaiBaoToolGhi[] = [
  {
    name: 'ghi_chu_phieu_thu_chi',
    description:
      'Lập ĐỀ XUẤT sửa GHI CHÚ của một phiếu thu/chi đã có. Tool này KHÔNG sửa gì: nó dựng bản xem ' +
      'trước (ghi chú cũ so với ghi chú mới) và hiện thẻ xác nhận cho người dùng bấm. Ghi chú mới ' +
      'THAY THẾ toàn bộ ghi chú cũ. Không đụng số tiền, hạng mục, trạng thái duyệt hay ảnh chứng từ.',
    chatOnly: true,
    requiredPermission: { module: 'income_expenses', action: 'edit' },
    actionId: 'income_expense.annotate',
  },
  {
    name: 'dat_han_giu_cho',
    description:
      'Lập ĐỀ XUẤT đặt kỳ hạn giữ chỗ cho một phiếu THU cọc: hạn làm hợp đồng, hạn bổ sung cọc, số ' +
      'cọc cần đủ. Tool này KHÔNG đặt gì: nó dựng bản xem trước (giá trị cũ so với giá trị mới) và ' +
      'hiện thẻ xác nhận. Không đụng số tiền của phiếu. Bỏ trống cả ba mốc = gỡ kỳ hạn.',
    chatOnly: true,
    requiredPermission: { module: 'deposits', action: 'edit' },
    actionId: 'reservation.set_hold_terms',
  },
  {
    name: 'dat_co_hoi_thoai_zalo',
    description:
      'Lập ĐỀ XUẤT đổi ba cờ hiển thị của một hội thoại Zalo: ghim, tắt tiếng, đánh dấu chưa đọc. ' +
      'Tool này KHÔNG đổi gì và KHÔNG gửi tin nhắn nào: nó dựng bản xem trước và hiện thẻ xác nhận. ' +
      'Cờ nào bỏ trống thì giữ nguyên.',
    chatOnly: true,
    requiredPermission: { module: 'chat_zalo', action: 'view' },
    actionId: 'zalo.set_conversation_flags',
  },
];

/** Hình dạng chung mà mọi RPC xem trước theo Nonce ABI v1 trả về. */
interface KetQuaXemTruocHanhDong {
  confirmation_nonce: string;
  canonical: unknown;
  preview: Record<string, unknown>;
}

/** Hình dạng chung mà mọi RPC thực thi theo Nonce ABI v1 trả về. */
interface KetQuaThucThiHanhDong {
  status?: string;
  entity_table?: string;
  entity_id?: string;
  audit_id?: string;
  ledger_id?: string;
}

/**
 * Biên có kiểu cho các RPC hành động — chúng chưa có trong `types.ts` sinh tự
 * động (migration chưa apply), và `supabase.rpc` chỉ nhận tên đã sinh.
 *
 * Cùng khuôn với `callCopilotRpc` trong `registry.ts`. `supabase.rpc` KHÔNG bao
 * giờ ném: lỗi mạng và lỗi 5xx đều về dưới dạng `{ error }` của một promise đã
 * fulfil, nên mọi nơi gọi hàm này đọc `error` chứ không bọc `try/catch`.
 */
function goiRpcHanhDong<TData>(
  tenRpc: string,
  thamSo: Record<string, unknown>,
): PromiseLike<{ data: TData | null; error: { message?: string } | null }> {
  return (
    supabase.rpc as unknown as (
      name: string,
      params: Record<string, unknown>,
    ) => PromiseLike<{ data: TData | null; error: { message?: string } | null }>
  )(tenRpc, thamSo);
}

/** Lỗi chung của mọi hành động theo Nonce ABI v1 → câu tiếng Việt. */
const GIAI_THICH_LOI_HANH_DONG: Record<string, string> = {
  organization_required:
    'Chưa chọn công ty. Bảo người dùng chọn công ty ở nhãn trên thanh đầu trang.',
  copilot_action_disabled:
    'Hành động này đang bị TẮT bởi quản trị (kill switch). Không có cách nào chạy nó cho tới khi super admin bật lại ở trang quản trị AI Copilot.',
  tenant_emergency_denied:
    'Công ty này đang trong lệnh cấm khẩn cấp — mọi thao tác ghi bị chặn. Báo người dùng liên hệ quản trị.',
  not_permitted: 'Người dùng không có quyền thực hiện thao tác này trong công ty đang chọn.',
  entity_not_found:
    'Không tìm thấy đối tượng đó trong công ty đang chọn. Hỏi lại mã/tên chính xác rồi thử lại.',
  payload_invalid: 'Dữ liệu gửi lên không hợp lệ. Kiểm tra lại các trường bắt buộc.',
  ghi_chu_bat_buoc: 'Thiếu nội dung ghi chú mới.',
  ghi_chu_qua_dai: 'Ghi chú quá dài (tối đa 5000 ký tự).',
  khong_co_co_nao_doi:
    'Chưa nêu cờ nào cần đổi. Hỏi người dùng muốn ghim, tắt tiếng hay đánh dấu chưa đọc.',
  unauthenticated: 'Phiên đăng nhập đã hết hạn. Bảo người dùng đăng nhập lại.',
};

export function dienGiaiLoiHanhDong(message: string, nhan: string): string {
  for (const [ma, cau] of Object.entries(GIAI_THICH_LOI_HANH_DONG)) {
    if (message.includes(ma)) return cau;
  }
  return `Lỗi khi lập đề xuất "${nhan}": ${message}`;
}

/** Một giá trị trong khối `preview` → chuỗi người đọc được. */
export function chuoiGiaTriXemTruoc(giaTri: unknown): string {
  if (giaTri === null || giaTri === undefined || giaTri === '') return '(trống)';
  if (typeof giaTri === 'boolean') return giaTri ? 'Có' : 'Không';
  return String(giaTri);
}

/** Nhãn tiếng Việt của một trường xem trước; thiếu nhãn thì dùng chính tên khoá. */
export function nhanTruongXemTruoc(truong: string): string {
  return NHAN_TRUONG_XEM_TRUOC[truong] ?? truong;
}

/**
 * Bản xem trước dạng văn bản cho mô hình đọc.
 *
 * CHỈ đi qua `entry.previewFields` — không lặp `Object.keys(preview)`. Server có
 * thể trả thêm trường trong một bản sau, và một vòng lặp theo khoá thật sẽ đọc
 * thẳng trường đó vào ngữ cảnh mô hình mà không ai duyệt. Danh sách trường là
 * một phần của hợp đồng, nên nó phải nằm ở phía đọc.
 */
export function dungBanXemTruoc(
  entry: ActionCatalogEntry,
  preview: Record<string, unknown>,
): string {
  const dong = entry.previewFields.map(
    (truong) => `- ${nhanTruongXemTruoc(truong)}: ${chuoiGiaTriXemTruoc(preview[truong])}`,
  );
  return [`${entry.labelVi.toUpperCase()} — CHỜ XÁC NHẬN:`, ...dong].join('\n');
}

/**
 * Chỉ dẫn kèm bản xem trước cho các action L3 — bản chung của
 * `TEXT_XEM_TRUOC_MAU`, không mang câu chữ riêng của việc tạo phiếu.
 */
export const TEXT_XEM_TRUOC_MAU_HANH_DONG =
  '⚠️ CHƯA THỰC HIỆN. Người dùng sẽ thấy một thẻ xác nhận ngay dưới tin nhắn này và tự bấm nút. ' +
  'BƯỚC TIẾP THEO CỦA BẠN: trả lời thẳng bằng văn bản (không dùng thêm tool nào), nhắc lại ngắn gọn ' +
  'nội dung thay đổi và mời họ kiểm tra rồi bấm nút. KHÔNG dùng lại tool này cho cùng một thay đổi, ' +
  'và KHÔNG có cách nào để bạn tự xác nhận thay người dùng.';

/**
 * Sinh một `DomainTool` ghi từ một dòng khai báo + hàng tương ứng trong sổ.
 *
 * `chatOnly` và `requiredPermission` lấy từ dòng khai báo (bản mà hai gate regex
 * đọc được), `inputSchema`/`previewRpc`/`labelVi` lấy từ sổ. Không trường nào bị
 * bỏ qua, nên không có trường nào "sửa mà không thấy gì đổi".
 */
export function taoToolGhiTuCatalog(khai: KhaiBaoToolGhi): DomainTool<Record<string, unknown>> {
  const entry = ACTION_CATALOG[khai.actionId] as ActionCatalogEntry;
  return {
    name: khai.name,
    description: khai.description,
    inputSchema: entry.inputSchema as z.ZodType<Record<string, unknown>>,
    requiredPermission: khai.requiredPermission,
    chatOnly: khai.chatOnly,
    rolloutKey: khoaRolloutHanhDong(khai.actionId),
    execute: async (args, ctx) => {
      const orgId = chotToChuc(ctx, khai.name);
      const threadId = ctx.threadId ?? null;

      const { data, error } = await goiRpcHanhDong<KetQuaXemTruocHanhDong>(entry.previewRpc, {
        p_organization_id: orgId,
        p_payload: args,
      });
      if (error) return dienGiaiLoiHanhDong(error.message ?? String(error), entry.labelVi);

      if (!data?.confirmation_nonce) {
        throw new Error('Server không trả về mã xác nhận — không lập được đề xuất.');
      }

      // Nonce rẽ sang bộ nhớ cho giao diện; KHÔNG đi vào chuỗi trả về.
      datXacNhanDangCho({
        tool: entry.actionId,
        nonce: data.confirmation_nonce,
        canonical: data.canonical,
        preview: data.preview,
        organizationId: orgId,
        threadId,
        generation: ctx.generation,
        intentKey: makeIdempotencyKey([
          entry.actionId,
          orgId,
          threadId ?? '',
          canonicalJson(data.canonical),
        ]),
      });

      return `${dungBanXemTruoc(entry, data.preview)}\n\n${TEXT_XEM_TRUOC_MAU_HANH_DONG}`;
    },
  };
}

/** Ba tool ghi L3 sinh từ sổ hành động — `registry.ts` trải mảng này vào registry. */
export const TOOL_GHI_HANH_DONG: DomainTool[] = KHAI_BAO_TOOL_GHI.map(taoToolGhiTuCatalog);

/** Để test đo được bảng khai báo mà không phải bóc lại từ mảng tool đã dựng. */
export const KHAI_BAO_TOOL_GHI_DE_DO: readonly KhaiBaoToolGhi[] = KHAI_BAO_TOOL_GHI;

/**
 * Thực thi một đề xuất L3 đang chờ. CHỈ giao diện gọi, sau một cú bấm thật.
 *
 * Đối xứng với `thucThiXacNhan` của đường tạo phiếu, nhưng không mang câu chữ
 * riêng của phiếu thu/chi: RPC thực thi lấy từ `ACTION_CATALOG[tool].executeRpc`,
 * và câu báo thành công dựng từ `labelVi`.
 */
export async function thucThiXacNhanHanhDong(
  tool: ActionId,
  nonce: string,
  canonical: unknown,
  expectedContext: ConfirmationExecutionContext,
): Promise<string> {
  const entry = ACTION_CATALOG[tool] as ActionCatalogEntry | undefined;
  if (!entry) throw new Error(`hanh_dong_khong_co_trong_so: ${tool}`);

  const current = layNguCanhXacNhan();
  if (
    !current ||
    current.organizationId !== expectedContext.organizationId ||
    current.threadId !== expectedContext.threadId ||
    (expectedContext.generation !== undefined && current.generation !== expectedContext.generation)
  ) {
    throw new Error('confirmation_scope_mismatch: organization or conversation changed');
  }

  const { data, error } = await goiRpcHanhDong<KetQuaThucThiHanhDong>(entry.executeRpc, {
    p_confirmation_nonce: nonce,
    p_payload: canonical,
  });
  if (error) {
    const m = error.message ?? String(error);
    if (m.includes('confirmation_expired')) {
      return '⏱️ Đề xuất đã quá hạn (5 phút). Hãy yêu cầu Copilot lập lại.';
    }
    if (m.includes('confirmation_already_used')) {
      return '⚠️ Đề xuất này đã được dùng rồi — không làm lại.';
    }
    if (m.includes('payload_changed')) {
      return '⚠️ Nội dung đã thay đổi sau khi xem trước. Hãy lập lại đề xuất.';
    }
    if (
      m.includes('confirmation_not_found') ||
      m.includes('confirmation_required') ||
      m.includes('confirmation_contract_mismatch')
    ) {
      return '⚠️ Không tìm thấy đề xuất hợp lệ. Hãy yêu cầu Copilot lập lại.';
    }
    if (m.includes('copilot_action_disabled')) {
      return '⚠️ Hành động đã bị tắt bởi quản trị. Hãy bật lại ở trang quản trị AI Copilot rồi lập lại.';
    }
    throw new Error(`Lỗi khi ${entry.labelVi.toLowerCase()}: ${m}`);
  }

  if (data?.status === 'da_thuc_hien_truoc_do') {
    return `⚠️ "${entry.labelVi}" đã được thực hiện trước đó — không làm lại.`;
  }
  return `✅ Đã ${entry.labelVi.toLowerCase()}.`;
}

/**
 * Điểm vào DUY NHẤT của thẻ xác nhận.
 *
 * Đường tạo phiếu giữ hàm riêng vì câu báo của nó đọc lại MÃ PHIẾU vừa tạo —
 * thứ người dùng cần để đi tra, và thứ không hành động nào khác có. Mọi hành
 * động còn lại đi đường chung.
 */
export async function thucThiXacNhanTheoTool(
  tool: string,
  nonce: string,
  canonical: unknown,
  expectedContext: ConfirmationExecutionContext,
): Promise<string> {
  if (tool === 'income_expense.create_draft') {
    return thucThiXacNhan(nonce, canonical, expectedContext);
  }
  if (!(tool in ACTION_CATALOG)) {
    throw new Error(`hanh_dong_khong_co_trong_so: ${tool}`);
  }
  return thucThiXacNhanHanhDong(tool as ActionId, nonce, canonical, expectedContext);
}
