// Thông báo thưởng khi hoàn thành công việc.
//
// Gọi sau khi job được set COMPLETED thành công. Quy trình:
//   1) RPC award_job_bonus(p_job_id) (SECURITY DEFINER) tính thưởng theo đúng quy
//      tắc salary_work_ledger, INSERT vào notifications (dedup), trả CHỈ dòng MỚI.
//   2) Với mỗi dòng mới: popup nổi gamified (Sonner toast.custom + BonusToast)
//      + Web Push tới chính mình (send-push self-mode, qua JWT — như sendTestPush).
//
// Người nhận = assignee = chính user đang đăng nhập (luồng hoàn thành bắt buộc
// chụp ảnh trực tiếp tại chỗ) nên self-push là đủ, không cần service role.

import { createElement } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import BonusToast, { formatBonusK } from '@/components/tasks/BonusToast';

export interface AwardedBonus {
  bonus_kind: 'JOB' | 'DAY_BONUS';
  amount: number;
  label: string;
  place: string;
  content: string;
  notif_id: string;
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

  rows.forEach((row, i) => {
    // Popup nổi — stagger nhẹ để tạo cảm giác "combo" khi có nhiều dòng cùng lúc.
    setTimeout(() => {
      toast.custom(
        () =>
          createElement(BonusToast, {
            amount: row.amount,
            label: row.label,
            place: row.place,
          }),
        { duration: 5000 },
      );
    }, i * 250);

    // Web Push tới chính mình (thanh trạng thái) — nuốt lỗi êm (chưa bật push → sent:0).
    supabase.functions
      .invoke('send-push', {
        body: {
          title: `🎉 ${formatBonusK(row.amount)} thưởng`,
          body: row.content,
          url: '/finance/salary',
          tag: `bonus-${jobId}-${row.bonus_kind}`,
        },
      })
      .catch((e) => console.warn('[bonus] send-push failed', e));
  });

  return rows;
}
