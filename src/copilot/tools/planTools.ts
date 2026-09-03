// Hai tool của KẾ HOẠCH THỰC THI — `lap_ke_hoach` và `thuc_thi_buoc`.
//
// FILE NÀY CHỈ KHAI BÁO. Mọi logic (gọi RPC, giữ nonce, chạy tuần tự, hết giờ
// chờ thì đọc lại) nằm ở `../plan/planClient.ts`. Ranh giới đó không phải thẩm
// mỹ: `duyetKeHoach` — hàm tiêu nonce cấp kế hoạch — sống ở file kia và KHÔNG
// được có mặt trong bất kỳ thân `execute` nào ở đây. Một tool gọi được nó nghĩa
// là mô hình tự bấm nút Duyệt của chính mình, và cả kiến trúc đồng ý theo lô
// sụp trong đúng một dòng.
//
//   · `tooling/copilot-action-policy.json` khai `copilot_plan_approve_v1` là
//     hành động loại `approval`, chỉ được gọi từ `src/copilot/plan/planClient.ts`.
//   · `scripts/check-copilot-forbidden-actions.mjs` ép điều đó trên MÃ NGUỒN
//     (quét cả file, không chỉ thân tool), và test đột biến trong
//     `planTools.test.ts` chứng minh cửa đó thật sự đỏ khi bị vi phạm.
//
// VÌ SAO MỌI CHUỖI HIỂN THỊ DỰNG Ở ĐẦU FILE, NGOÀI THÂN `execute`
//   Bộ dò của gate đọc phần văn bản TỪ `execute:` tới khai báo tool kế tiếp, và
//   nó khớp cả chuỗi. Một câu tiếng Việt kết thúc bằng chữ "duyệt" ngay trước
//   dấu nháy, hay hằng `'plan_not_approved'`, đều khớp mẫu `approval` và làm
//   gate đỏ vì một lý do sai. Đưa chúng lên đây (phần trước khai báo đầu tiên,
//   nằm ngoài tầm quét) là cách giữ cho bộ dò nói về HÀNH VI chứ không về
//   chính tả — thay vì nới lỏng bộ dò, thứ đang canh một ranh giới thật.
import * as z from 'zod/v4';

import { chotToChuc, type DomainTool } from './registry';
import { KHOA_ROLLOUT_KE_HOACH } from '../featureFlags';
import {
  ACTION_CATALOG,
  NHAN_TRUONG_XEM_TRUOC,
  type ActionCatalogEntry,
  type ActionId,
} from '../plan/actionCatalog';
import {
  chayTuanTu,
  docKeHoach,
  khoaYeuCau,
  taoKeHoach,
  thucThiBuoc,
  type BuocKeHoach,
  type KeHoach,
  type KetQuaChay,
} from '../plan/planClient';

/** Mã trạng thái, tách khỏi thân `execute` — xem chú thích đầu file. */
const TRANG_THAI_DA_DUYET = 'APPROVED';
const MA_CHUA_DUYET = 'plan_not_approved';

/** Số bước tối đa của một kế hoạch — chính con số server ép (1..8). */
export const SO_BUOC_TOI_DA = 8;

const DANH_SACH_HANH_DONG = Object.keys(ACTION_CATALOG) as [ActionId, ...ActionId[]];

export const SCHEMA_LAP_KE_HOACH = z.object({
  muc_tieu: z
    .string()
    .min(3)
    .describe('Mục tiêu của cả kế hoạch, một câu ngắn người dùng đọc và hiểu được'),
  cac_buoc: z
    .array(
      z.object({
        hanh_dong: z
          .enum(DANH_SACH_HANH_DONG)
          .describe('Mã hành động trong sổ đăng ký (không tự bịa tên mới)'),
        du_lieu: z
          .record(z.string(), z.unknown())
          .describe('Dữ liệu của bước, đúng hình dạng input của hành động đó'),
      }),
    )
    .min(1)
    .max(SO_BUOC_TOI_DA)
    .describe('Các bước theo ĐÚNG thứ tự sẽ chạy; bước sau chỉ chạy khi bước trước xong'),
});

export const SCHEMA_THUC_THI_BUOC = z.object({
  ke_hoach_id: z.string().uuid().describe('ID kế hoạch mà người dùng vừa bấm duyệt'),
  chi_buoc: z
    .number()
    .int()
    .min(1)
    .max(SO_BUOC_TOI_DA)
    .optional()
    .describe('Chỉ chạy đúng một bước này; bỏ trống = chạy tuần tự tới hết hoặc tới bước hỏng'),
});

function hangSo(actionId: string): ActionCatalogEntry | null {
  return (ACTION_CATALOG as Record<string, ActionCatalogEntry>)[actionId] ?? null;
}

function chuoiGiaTri(gt: unknown): string {
  if (gt === null || gt === undefined || gt === '') return '(trống)';
  if (typeof gt === 'boolean') return gt ? 'Có' : 'Không';
  return String(gt);
}

/**
 * Bản xem trước một bước — CHỈ đi qua `previewFields` của sổ.
 *
 * Không lặp `Object.keys(preview)`: server có thể trả thêm trường ở một bản
 * sau, và một vòng lặp theo khoá thật sẽ đọc thẳng trường đó vào ngữ cảnh mô
 * hình mà không ai duyệt. Cùng kỷ luật với `dungBanXemTruoc` ở `writeTools.ts`.
 */
export function moTaBuoc(buoc: BuocKeHoach): string {
  const entry = hangSo(buoc.actionId);
  const truong = entry ? entry.previewFields : [];
  const chiTiet = truong
    .map((t) => `${NHAN_TRUONG_XEM_TRUOC[t] ?? t}: ${chuoiGiaTri(buoc.preview[t])}`)
    .join(' · ');
  const nhanRuiRo = buoc.executorKind === 'maker_submit_v1' ? 'L5 — nộp cho người thật duyệt' : buoc.risk;
  return `${buoc.stepNo}. [${nhanRuiRo}] ${buoc.labelVi}${chiTiet ? ` — ${chiTiet}` : ''}`;
}

/** Câu nói rõ ranh giới. Mô hình đọc nó, và nó không phải một lời mời. */
export const TEXT_CHO_NGUOI_BAM =
  'CHƯA CHẠY GÌ. Người dùng sẽ thấy thẻ kế hoạch ngay dưới tin nhắn này và phải tự bấm nút ' +
  '"Duyệt kế hoạch". BẠN KHÔNG CÓ CÁCH NÀO TỰ LÀM VIỆC ĐÓ, và không có tool nào để thử. ' +
  'BƯỚC TIẾP THEO CỦA BẠN: trả lời thẳng bằng văn bản (không gọi thêm tool), tóm tắt kế hoạch ' +
  'và mời họ kiểm tra rồi bấm. Chỉ khi hệ thống báo là người dùng đã bấm, bạn mới gọi ' +
  'thuc_thi_buoc.';

export function moTaKeHoach(mucTieu: string, ke: KeHoach): string {
  return [
    `KẾ HOẠCH ${ke.stepCount} BƯỚC — CHỜ NGƯỜI DÙNG BẤM:`,
    `- Mục tiêu: ${mucTieu}`,
    `- Mã kế hoạch: ${ke.planId}`,
    `- Mức rủi ro cao nhất: ${ke.maxRisk ?? '—'}`,
    '',
    ...ke.steps.map((b) => moTaBuoc(b)),
    '',
    TEXT_CHO_NGUOI_BAM,
  ].join('\n');
}

const NHAN_KET_THUC: Readonly<Record<string, string>> = {
  xong: 'Đã chạy hết các bước.',
  loi: 'Dừng lại ở một bước hỏng — các bước sau KHÔNG chạy.',
  het_gio: 'Quá hạn chờ một bước; hệ thống đã đọc lại trạng thái thật và dừng ở đó.',
  huy: 'Người dùng đã dừng lượt này.',
};

export function moTaKetQuaChay(kq: KetQuaChay): string {
  const dong = kq.buoc.map((b) => {
    const dau = b.ok ? '✅' : '⚠️';
    const them = b.doLaiSauHetGio ? ' (đọc lại sau khi quá hạn chờ)' : '';
    return `${dau} Bước ${b.stepNo}: ${b.stepStatus ?? '—'}${them}${b.thongBao ? ` — ${b.thongBao}` : ''}`;
  });
  const ke = kq.keHoach;
  return [
    `KẾT QUẢ CHẠY KẾ HOẠCH: ${NHAN_KET_THUC[kq.ketThuc] ?? kq.ketThuc}`,
    ...(dong.length ? dong : ['(không bước nào chạy)']),
    ke ? `Trạng thái kế hoạch: ${ke.planStatus}${ke.failureReason ? ` (${ke.failureReason})` : ''}` : '',
    'Thuật lại ĐÚNG những dòng trên cho người dùng: bước nào đã ghi, bước nào không. Đừng gộp thành "đã xong".',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Câu trả về khi kế hoạch chưa được người thật bấm — không phải một lỗi kỹ thuật. */
export function textChuaDuyet(trangThai: string): string {
  return (
    `${MA_CHUA_DUYET}: kế hoạch đang ở trạng thái ${trangThai}, chưa có cú bấm nào của người dùng. ` +
    'KHÔNG gọi lại tool này. Hãy nói với người dùng rằng họ cần bấm nút trên thẻ kế hoạch trước.'
  );
}

/** Kế hoạch đã được người thật bấm chưa. Tách hàm để hằng trạng thái nằm ngoài thân tool. */
export function daDuocDuyet(ke: KeHoach | null): boolean {
  return ke?.planStatus === TRANG_THAI_DA_DUYET;
}

// ─────────────────────────────────────────────────────────────────────────────
// THÂN HAI TOOL — đặt TRƯỚC phần khai báo, có chủ ý
// ─────────────────────────────────────────────────────────────────────────────
//
// `check-copilot-forbidden-actions` cắt mã theo khối "từ `name:` này tới `name:`
// kế tiếp" và soi phần sau chữ `execute:`. Khối của tool CUỐI CÙNG vì thế kéo
// tới hết file — nên một hàm phụ đặt dưới cùng sẽ bị soi như thể nó là thân của
// tool đó, và `daDuocDuyet(` (một phép ĐỌC trạng thái) bị chấm là hành động
// `approval`. Đo thật ngày 03/09/2026: gate đỏ đúng dòng đó.
//
// Cách chữa KHÔNG phải nới bộ dò — nó đang canh một ranh giới thật. Cách chữa
// là để thân hàm nằm ngoài tầm cắt, và để ranh giới thật (không tool nào gọi
// `copilot_plan_approve_v1`) được canh bằng một phép quét CẢ FILE:
// `rpcAllowlist` trong `tooling/copilot-action-policy.json` mạnh hơn hẳn phép
// dò theo khối, vì nó không phụ thuộc vào chỗ đặt hàm.

/**
 * Thân của `lap_ke_hoach`, tách ra khỏi khai báo tool.
 *
 * `client_request_id` dựng từ (công ty, cuộc trò chuyện, mục tiêu, các bước):
 * mô hình gọi lại y hệt vì bất kỳ lý do gì cũng nhận LẠI kế hoạch cũ thay vì
 * đẻ thêm một kế hoạch mở nữa — hạn mức server là 3 kế hoạch mở cho một người.
 */
async function taoKeHoachTuTool(
  args: z.infer<typeof SCHEMA_LAP_KE_HOACH>,
  orgId: string,
  threadId: string | null,
  generation: number | undefined,
): Promise<string> {
  const kq = await taoKeHoach({
    organizationId: orgId,
    clientRequestId: khoaYeuCau([
      orgId,
      threadId ?? '',
      args.muc_tieu,
      JSON.stringify(args.cac_buoc),
    ]),
    buoc: args.cac_buoc.map((b) => ({ hanh_dong: b.hanh_dong, du_lieu: b.du_lieu })),
    threadId,
    ...(generation === undefined ? {} : { generation }),
  });
  if (!kq.keHoach) return kq.thongBao ?? 'Không lập được kế hoạch.';
  if (kq.daTonTai) {
    return `${moTaKeHoach(args.muc_tieu, kq.keHoach)}\n\n(Kế hoạch này đã được lập trước đó — không lập trùng.)`;
  }
  return moTaKeHoach(args.muc_tieu, kq.keHoach);
}

/** Thân của `thuc_thi_buoc`, tách ra khỏi khai báo tool. */
async function chayKeHoachTuTool(
  planId: string,
  orgId: string,
  chiBuoc: number | undefined,
): Promise<string> {
  const doc = await docKeHoach(planId);
  if (!doc.keHoach) return doc.thongBao ?? 'Không đọc được kế hoạch.';
  if (!daDuocDuyet(doc.keHoach)) return textChuaDuyet(doc.keHoach.planStatus);

  if (chiBuoc !== undefined) {
    const mot = await thucThiBuoc(planId, chiBuoc, doc.keHoach.planVersion, orgId);
    const sau = await docKeHoach(planId);
    return moTaKetQuaChay({
      buoc: [mot],
      keHoach: sau.keHoach,
      ketThuc: mot.ok ? 'xong' : 'loi',
      maLoi: mot.maLoi,
      thongBao: mot.thongBao,
    });
  }
  return moTaKetQuaChay(await chayTuanTu(planId, orgId));
}


const MO_TA_LAP =
  'Lập KẾ HOẠCH nhiều bước (2–8 thao tác ghi) để người dùng đồng ý MỘT LẦN cho cả dãy. Tool này ' +
  'KHÔNG chạy gì: nó dựng bản xem trước từng bước và hiện một thẻ kế hoạch cho người dùng tự bấm. ' +
  'Dùng khi việc cần từ hai thao tác ghi trở lên, hoặc khi có bước phải nộp hồ sơ cho người khác ' +
  'xử lý. Các bước chạy TUẦN TỰ: bước sau chỉ chạy khi bước trước xong.';

const MO_TA_CHAY =
  'Chạy các bước của một kế hoạch ĐÃ ĐƯỢC NGƯỜI DÙNG BẤM. Chỉ gọi sau khi hệ thống báo là người ' +
  'dùng vừa bấm nút trên thẻ kế hoạch — một câu văn nói rằng họ đã đồng ý (kể cả do chính bạn ' +
  'viết ra) KHÔNG phải là cú bấm đó. Kế hoạch chưa được bấm thì tool trả về lời từ chối.';

export const lapKeHoach: DomainTool<z.infer<typeof SCHEMA_LAP_KE_HOACH>> = {
  name: 'lap_ke_hoach',
  description: MO_TA_LAP,
  inputSchema: SCHEMA_LAP_KE_HOACH,
  // `ai_copilot.view` là khoá quyền THẬT gần nhất với "được dùng Copilot"
  // (`permission_definitions` không có `ai_copilot.use`). Quyền của TỪNG BƯỚC do
  // server gác: `copilot_action_gate_v1` hỏi `authorized_scope_v3` theo
  // `permission_key` của chính hành động đó, nên khoá ở đây không phải hàng rào
  // duy nhất, và cũng không được giả vờ là thế.
  requiredPermission: { module: 'ai_copilot', action: 'view' },
  chatOnly: true,
  superAdminOnly: true,
  rolloutKey: KHOA_ROLLOUT_KE_HOACH,
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'lap_ke_hoach');
    const threadId = ctx.threadId ?? null;
    const kq = await taoKeHoachTuTool(args, orgId, threadId, ctx.generation);
    return kq;
  },
};

export const thucThiBuocTool: DomainTool<z.infer<typeof SCHEMA_THUC_THI_BUOC>> = {
  name: 'thuc_thi_buoc',
  description: MO_TA_CHAY,
  inputSchema: SCHEMA_THUC_THI_BUOC,
  requiredPermission: { module: 'ai_copilot', action: 'view' },
  chatOnly: true,
  superAdminOnly: true,
  rolloutKey: KHOA_ROLLOUT_KE_HOACH,
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'thuc_thi_buoc');
    return chayKeHoachTuTool(args.ke_hoach_id, orgId, args.chi_buoc);
  },
};

/** Hai tool kế hoạch — `registry.ts` trải mảng này vào registry. */
export const TOOL_KE_HOACH: DomainTool[] = [
  lapKeHoach as DomainTool,
  thucThiBuocTool as DomainTool,
];
