// Thông báo thưởng khi hoàn thành công việc — gộp "Combo".
//
// Gọi sau khi job được set COMPLETED thành công. Quy trình:
//   1) RPC award_job_bonus(p_job_id) (SECURITY DEFINER) tính các khoản thưởng
//      (JOB + DAY_BONUS) theo đúng quy tắc salary_work_ledger, INSERT vào
//      notifications (dedup), trả CHỈ các dòng MỚI kèm `icon`.
//   2) GỘP tất cả dòng của 1 lần hoàn thành thành MỘT popup "combo": tổng to +
//      phân rã từng khoản. ≥2 khoản → thẻ vàng/lửa/X2; 1 khoản → thẻ xanh.
//   3) Một Web Push tới chính mình (send-push self-mode, qua JWT).
//
// Người nhận = assignee = chính user đang đăng nhập (luồng hoàn thành bắt buộc
// chụp ảnh trực tiếp tại chỗ) nên self-push là đủ, không cần service role.

import { createElement } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import BonusToast, { formatBonusK } from '@/components/tasks/BonusToast';

/** Ngữ cảnh thời gian hoàn thành việc — chọn skin popup đơn (combo bỏ qua). */
export type BonusTimeContext = 'AFTER_HOURS' | 'SUNDAY' | 'HOLIDAY' | 'NORMAL';

export interface AwardedBonus {
  bonus_kind: 'JOB' | 'DAY_BONUS';
  amount: number;
  label: string; // loại việc (vd "Sửa chữa") / tên phụ cấp
  note: string | null; // ghi chú công việc = jobs.title (vd "vòi nước nhà tắm")
  place: string;
  content: string;
  icon: string;
  time_context: BonusTimeContext; // ngoài giờ / CN / Lễ / thường — award_job_bonus trả
  notif_id: string;
}

/** Skin popup đơn theo ngữ cảnh: ngoài giờ→đêm, CN→huân chương, Lễ→tri ân. */
export type BonusVariant = 'normal' | 'night' | 'medal' | 'fest';

function variantOf(ctx: BonusTimeContext | undefined): BonusVariant {
  switch (ctx) {
    case 'HOLIDAY':
      return 'fest';
    case 'SUNDAY':
      return 'medal';
    case 'AFTER_HOURS':
      return 'night';
    default:
      return 'normal';
  }
}

/**
 * Award + thông báo thưởng cho 1 job vừa hoàn thành.
 * KHÔNG throw — mọi lỗi (RPC / push) đều nuốt êm để không chặn UI hoàn thành việc.
 * Trả mảng các dòng thưởng MỚI (rỗng nếu job không thưởng / đã thưởng trước đó).
 */
export async function awardAndNotifyJobBonus(jobId: string): Promise<AwardedBonus[]> {
  let rows: AwardedBonus[] = [];
  try {
    // award_job_bonus chưa có trong Database types (regen sau) → cast như pattern push.ts
    const { data, error } = await (supabase.rpc as any)('award_job_bonus', {
      p_job_id: jobId,
    });
    if (error) {
      console.warn('[bonus] award_job_bonus error', error);
      return [];
    }
    rows = (data ?? []) as AwardedBonus[];
  } catch (e) {
    console.warn('[bonus] award_job_bonus threw', e);
    return [];
  }

  if (rows.length === 0) return rows;

  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const isCombo = rows.length >= 2;
  // Đơn: chọn skin theo ngữ cảnh thời gian (ngoài giờ/CN/Lễ) — combo giữ thẻ vàng.
  const variant: BonusVariant = isCombo ? 'normal' : variantOf(rows[0]?.time_context);

  // Một reward snackbar nổi TOP-CENTER (unstyled để thẻ glassmorphism chiếm trọn).
  // Auto-dismiss 4000ms; combo lâu hơn chút để đọc breakdown. Vuốt = Sonner tự lo.
  toast.custom(
    () => createElement(BonusToast, { items: rows, total, isCombo, variant }),
    { duration: isCombo ? 4500 : 4000, position: 'top-center', unstyled: true },
  );

  // Một Web Push (thanh trạng thái) — nuốt lỗi êm (chưa bật push → sent:0).
  const pushTitle = `🎉 ${formatBonusK(total)}${isCombo ? ' COMBO' : ' thưởng'}`;
  const pushBody = isCombo
    ? rows
        .map((r) => `${r.icon} ${r.label}${r.note ? ' ' + r.note : ''}: ${formatBonusK(r.amount)}`)
        .join('\n')
    : rows[0].content;
  supabase.functions
    .invoke('send-push', {
      body: { title: pushTitle, body: pushBody, url: '/finance/salary', tag: `bonus-${jobId}` },
    })
    .catch((e) => console.warn('[bonus] send-push failed', e));

  return rows;
}
