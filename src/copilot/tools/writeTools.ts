// WRITE TOOLS draft-first (Phase 5 PLAN.md v2.1).
// Nguyên tắc: (1) CHỈ tạo bản NHÁP (approval_status=UNAPPROVED, account_id=null
// — chưa vào sổ, người thật duyệt trên /income-expense); (2) confirmation 2 BƯỚC
// trong chat (xac_nhan=false → preview, chỉ khi user đồng ý mới xac_nhan=true);
// (3) idempotency: INSERT ai_write_audit (key UNIQUE) TRƯỚC — trùng 23505 =
// đã tạo rồi, trả entity cũ; (4) audit log giữ payload.
import * as z from 'zod/v4';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUser } from '@/lib/authSession';
import { formatVND } from '@/lib/utils';
import type { DomainTool } from './registry';

/** Hash chuỗi ổn định (djb2) — đủ cho idempotency key client-side. */
export function makeIdempotencyKey(parts: (string | number)[]): string {
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `iek_${(h >>> 0).toString(36)}_${s.length}`;
}

const inputSchema = z.object({
  loai: z.enum(['thu', 'chi']).describe('thu = phiếu THU, chi = phiếu CHI'),
  so_tien: z.number().positive().describe('Số tiền VND'),
  ten_phieu: z.string().min(3).describe('Tên/mô tả phiếu, vd "Chi mua bóng đèn toà X"'),
  toa_nha: z.string().min(1).describe('Tên toà nhà (khớp gần đúng)'),
  hang_muc: z.string().min(1).describe('Tên hạng mục thu/chi, vd "Vệ sinh", "Điện"'),
  ngay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('CHỈ truyền khi người dùng NÓI RÕ ngày cụ thể; bỏ trống = hệ thống tự lấy hôm nay (đừng tự đoán ngày)'),
  xac_nhan: z
    .boolean()
    .default(false)
    .describe('false = chỉ XEM TRƯỚC (bắt buộc lần đầu); true = tạo thật (CHỈ sau khi người dùng đồng ý)'),
});

type Input = z.infer<typeof inputSchema>;

async function resolveBuilding(name: string) {
  const { data, error } = await supabase
    .from('buildings')
    .select('id, name')
    .ilike('name', `%${name}%`)
    .is('deleted_at', null)
    .limit(5);
  if (error) throw new Error(`Lỗi tìm toà nhà: ${error.message}`);
  return data ?? [];
}

async function resolveType(name: string, ieType: 'INCOME' | 'EXPENSE') {
  // GOTCHA: income_expense_types.type là chữ THƯỜNG ('income'/'expense'),
  // trong khi income_expenses.type là HOA ('INCOME'/'EXPENSE').
  const { data, error } = await supabase
    .from('income_expense_types')
    .select('id, name, type')
    .eq('type', ieType.toLowerCase())
    .ilike('name', `%${name}%`)
    .limit(5);
  if (error) throw new Error(`Lỗi tìm hạng mục: ${error.message}`);
  return data ?? [];
}

export const taoPhieuThuChiNhap: DomainTool<Input> = {
  name: 'tao_phieu_thu_chi_nhap',
  description:
    'Tạo phiếu thu/chi BẢN CHỜ DUYỆT (chưa duyệt, chưa vào sổ quỹ). QUY TRÌNH BẮT BUỘC 2 BƯỚC: lần 1 gọi với xac_nhan=false để xem trước và HỎI người dùng; CHỈ khi người dùng trả lời đồng ý mới gọi lại với xac_nhan=true.',
  inputSchema,
  requiredPermission: { module: 'income_expenses', action: 'create' },
  execute: async (args) => {
    const user = await getSessionUser();
    if (!user) throw new Error('Chưa đăng nhập.');

    const ieType = args.loai === 'thu' ? 'INCOME' : 'EXPENSE';
    const voucherDate = args.ngay ?? new Date().toISOString().slice(0, 10);

    // Resolve toà + hạng mục (RLS scope theo user)
    const buildings = await resolveBuilding(args.toa_nha);
    if (!buildings.length) return `Không tìm thấy toà nhà nào khớp "${args.toa_nha}". Hỏi lại người dùng tên toà chính xác.`;
    if (buildings.length > 1) {
      return `Có ${buildings.length} toà khớp "${args.toa_nha}": ${buildings.map((b) => b.name).join(', ')}. Hỏi người dùng chọn toà nào rồi gọi lại với tên chính xác.`;
    }
    const types = await resolveType(args.hang_muc, ieType);
    if (!types.length) return `Không tìm thấy hạng mục ${args.loai} nào khớp "${args.hang_muc}". Hỏi lại người dùng.`;
    if (types.length > 1) {
      return `Có ${types.length} hạng mục khớp "${args.hang_muc}": ${types.map((t) => t.name).join(', ')}. Hỏi người dùng chọn rồi gọi lại với tên chính xác.`;
    }
    const building = buildings[0];
    const type = types[0];

    const preview =
      `PHIẾU ${args.loai === 'thu' ? 'THU' : 'CHI'} CHỜ DUYỆT:\n` +
      `- Tên: ${args.ten_phieu}\n- Số tiền: ${formatVND(args.so_tien)}\n` +
      `- Toà: ${building.name}\n- Hạng mục: ${type.name}\n- Ngày: ${voucherDate}\n` +
      `- Trạng thái: CHỜ DUYỆT (chưa duyệt, chưa vào sổ — người dùng duyệt tại /income-expense)`;

    if (!args.xac_nhan) {
      return `${preview}\n\n⚠️ CHƯA TẠO. BƯỚC TIẾP THEO BẮT BUỘC: gọi respond NGAY BÂY GIỜ, đưa bản xem trước trên cho người dùng và hỏi "Bạn xác nhận tạo phiếu này chứ?". KHÔNG gọi lại tool này cho đến khi người dùng trả lời đồng ý (khi đó mới gọi với xac_nhan=true, giữ nguyên tham số).`;
    }

    // Idempotency: INSERT audit trước, key từ nội dung phiếu (không gồm xac_nhan)
    const key = makeIdempotencyKey([user.id, ieType, args.so_tien, building.id, type.id, voucherDate, args.ten_phieu]);
    const { data: audit, error: auditErr } = await supabase
      .from('ai_write_audit')
      .insert({
        user_id: user.id,
        tool: 'tao_phieu_thu_chi_nhap',
        idempotency_key: key,
        entity_table: 'income_expenses',
        payload: { ...args, building_id: building.id, type_id: type.id },
      })
      .select('id')
      .single();
    if (auditErr) {
      if ((auditErr as { code?: string }).code === '23505') {
        const { data: prev } = await supabase
          .from('ai_write_audit')
          .select('entity_id, created_at')
          .eq('idempotency_key', key)
          .maybeSingle();
        return `⚠️ Phiếu này ĐÃ được tạo trước đó (${prev?.created_at ?? ''}) — không tạo trùng. Xem tại [Thu chi](/income-expense).`;
      }
      throw new Error(`Lỗi ghi audit: ${auditErr.message}`);
    }

    // Tạo phiếu NHÁP qua server RPC ie_compat_insert_v2 (Stage-7 drain: client
    // hết INSERT trực tiếp income_expenses/_items). Server ép approval_status
    // UNAPPROVED/PENDING + stamp maker; account_id null (sổ trống — chưa đụng
    // tiền thật). Phiếu + hạng mục atomic trong một call.
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const creatorName = String(meta.full_name || meta.name || user.email || 'Người dùng');
    const { data: created, error: vErr } = await (supabase.rpc as unknown as (
      fn: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message?: string } | null }>)(
      'ie_compat_insert_v2',
      {
        p_row: {
          user_id: user.id,
          creator_name: `${creatorName} (AI Copilot)`,
          type: ieType,
          name: args.ten_phieu,
          building_id: building.id,
          account_id: null,
          voucher_date: voucherDate,
          attachments: [],
          notes: `Tạo bởi AI Copilot (draft-first, audit ${audit.id})`,
          repeat_cycle: 'NONE',
          repeat_infinity: false,
          repeat_count: 0,
          repeat_auto_approve: true,
          repeat_remaining: 0,
        },
        p_items: [
          {
            income_expense_type_id: type.id,
            description: args.ten_phieu,
            quantity: 1,
            unit_price: args.so_tien,
          },
        ],
      },
    );
    if (vErr) throw new Error(`Lỗi tạo phiếu: ${vErr.message}`);
    const voucherId = (created as { id?: string } | null)?.id;
    if (!voucherId) throw new Error('Lỗi tạo phiếu: server không trả về id.');

    await supabase
      .from('ai_write_audit')
      .update({ entity_id: voucherId })
      .eq('id', audit.id);

    // RPC chỉ trả {id, approval_status} — đọc lại code (read-only) cho message.
    const { data: codeRow } = await supabase
      .from('income_expenses')
      .select('code')
      .eq('id', voucherId)
      .maybeSingle();
    const code = (codeRow as { code?: string } | null)?.code ?? voucherId.slice(0, 8);
    return `✅ Đã tạo phiếu ${args.loai === 'thu' ? 'THU' : 'CHI'} CHỜ DUYỆT ${code} — ${formatVND(args.so_tien)} — ${building.name}. Phiếu CHƯA duyệt, chưa vào sổ; người dùng kiểm tra và duyệt tại [Thu chi](/income-expense).`;
  },
};
