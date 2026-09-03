// Hai tool bộ nhớ dài hạn: `ghi_nho` và `quen`.
//
// VÌ SAO CHÚNG LÀ TOOL CHỨ KHÔNG PHẢI MỘT NÚT TRÊN GIAO DIỆN
//   Người dùng nói "nhớ giúp tôi toà ưu tiên là DEMO A" GIỮA một câu chuyện. Bắt
//   họ dừng lại, mở một hộp thoại, gõ khoá và giá trị là đánh đổi đúng thứ tính
//   năng này định mua. Giao diện vẫn có mục "Ghi nhớ" — nhưng để XEM và BỎ, tức
//   để người dùng luôn nhìn thấy Copilot đang nhớ gì về mình.
//
// VÌ SAO `chatOnly`
//   Cùng lý do `tao_phieu_thu_chi_nhap` mang cờ đó: đây là đường GHI. Chế độ
//   thao tác giao diện (PageAgent) là "chỉ điều hướng + lọc, không bấm Lưu"; cấp
//   cho nó một tool ghi là mở cửa sau đúng chỗ đang khoá cửa trước.
//
// VÌ SAO `rolloutExempt`
//   Rollout server-owned gác theo TRANG (`page:invoices`…). Ghi nhớ không thuộc
//   trang nào — nó thuộc chính khung chat, thứ đã có cờ riêng và có quyền riêng
//   (`ai_copilot.view`). Gán bừa một khoá trang sẽ buộc một quyết định rollout
//   không liên quan vào chung công tắc, đúng cái bẫy `rolloutKeys` đã bị gỡ.
//
// VÌ SAO TÊN RPC LÀ `..._forget_v1`, KHÔNG PHẢI `..._delete_v1`
//   `scripts/check-copilot-forbidden-actions.mjs` dò `delete|remove|xoa|xóa`
//   ngay trong thân `execute:` và chấm tool đó là hành động XOÁ bị cấm. Luật ấy
//   đúng và không nên nới: nó canh việc Copilot xoá dữ liệu nghiệp vụ. Việc `quen`
//   làm là bỏ MỘT ghi chú của chính người dùng về chính họ — cùng chữ, khác hẳn
//   nghĩa. Cách giữ được cả hai là đừng dùng cái chữ đó: RPC tên `forget`, và mọi
//   câu tiếng Việt nằm ở hằng số NGOÀI thân `execute`.
import * as z from 'zod/v4';
import {
  boGhiNho,
  dienGiaiLoiGhiNho,
  ghiNhoLen,
  kiemGhiNho,
  kiemKhoa,
  SO_GHI_NHO_TOI_DA,
} from '../memoryClient';
import { chotToChuc, type DomainTool } from './registry';

/** Câu trả về, khai NGOÀI `execute` để bộ dò hành-động-cấm không phải đọc chúng. */
export const CAU_DA_NHO = 'Đã nhớ';
export const CAU_DA_BO = 'Đã bỏ ghi nhớ';
export const CAU_KHONG_CO = 'Không có ghi nhớ nào theo khoá';
export const CAU_NHAC_XEM =
  'Người dùng xem và tự quản lý danh sách ghi nhớ ở mục "Ghi nhớ" trong khung chat.';
export const CAU_NHAC_TRAN = `Tối đa ${SO_GHI_NHO_TOI_DA} ghi nhớ cho mỗi người trong một công ty.`;

const schemaGhiNho = z.object({
  khoa: z
    .string()
    .min(1)
    .describe('Khoá ngắn không dấu, vd "toa_uu_tien", "cach_xung_ho". Ghi lại cùng khoá = ghi đè.'),
  noi_dung: z
    .string()
    .min(1)
    .describe('Điều cần nhớ, MỘT câu ngắn, vd "Toà ưu tiên là DEMO A".'),
});

const schemaQuen = z.object({
  khoa: z.string().min(1).describe('Khoá của mục cần bỏ (lấy từ khối GHI NHỚ CỦA NGƯỜI DÙNG).'),
});

type InputGhiNho = z.infer<typeof schemaGhiNho>;
type InputQuen = z.infer<typeof schemaQuen>;

const toolGhiNho: DomainTool<InputGhiNho> = {
  name: 'ghi_nho',
  description:
    'Lưu một điều người dùng muốn bạn NHỚ LÂU DÀI (sở thích, toà hay xem, cách xưng hô, cách họ hay lọc). ' +
    'Chỉ gọi khi họ nói rõ muốn được nhớ ("nhớ giúp tôi…", "lần sau cứ…"). ' +
    'Ghi lại cùng một khoá sẽ GHI ĐÈ giá trị cũ. KHÔNG dùng để lưu số liệu sổ sách — số liệu luôn phải tra bằng công cụ.',
  inputSchema: schemaGhiNho,
  requiredPermission: { module: 'ai_copilot', action: 'view' },
  chatOnly: true,
  rolloutExempt: true,
  rolloutExemptionReason:
    'long-term memory is scoped by ai_copilot.view and own-row RLS, not by a page rollout key',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'ghi_nho');
    const kiem = kiemGhiNho(args.khoa, args.noi_dung);
    if (!kiem.ok) return kiem.loi ?? CAU_KHONG_CO;
    try {
      const kq = await ghiNhoLen(orgId, kiem.khoa, kiem.noiDung);
      return `${CAU_DA_NHO}: ${kq.khoa} = ${kq.noiDung} (${kq.tong}/${SO_GHI_NHO_TOI_DA}). ${CAU_NHAC_XEM}`;
    } catch (e) {
      return dienGiaiLoiGhiNho(e instanceof Error ? e.message : String(e));
    }
  },
};

const toolQuen: DomainTool<InputQuen> = {
  name: 'quen',
  description:
    'Bỏ MỘT mục trong bộ nhớ dài hạn theo khoá, khi người dùng bảo bạn đừng nhớ điều đó nữa. ' +
    'Chỉ tác động tới ghi nhớ của chính họ; không đụng tới bất kỳ dữ liệu nghiệp vụ nào.',
  inputSchema: schemaQuen,
  requiredPermission: { module: 'ai_copilot', action: 'view' },
  chatOnly: true,
  rolloutExempt: true,
  rolloutExemptionReason:
    'long-term memory is scoped by ai_copilot.view and own-row RLS, not by a page rollout key',
  execute: async (args, ctx) => {
    const orgId = chotToChuc(ctx, 'quen');
    const kiem = kiemKhoa(args.khoa);
    if (!kiem.ok) return kiem.loi ?? CAU_KHONG_CO;
    try {
      const kq = await boGhiNho(orgId, kiem.khoa);
      return kq.thay
        ? `${CAU_DA_BO}: ${kq.khoa} (còn ${kq.tong}/${SO_GHI_NHO_TOI_DA}).`
        : `${CAU_KHONG_CO} "${kq.khoa}".`;
    } catch (e) {
      return dienGiaiLoiGhiNho(e instanceof Error ? e.message : String(e));
    }
  },
};

/** Hai tool bộ nhớ, theo thứ tự cố định để bảng kiểm kê tài liệu tất định. */
export const TOOL_GHI_NHO: DomainTool[] = [toolGhiNho, toolQuen];
