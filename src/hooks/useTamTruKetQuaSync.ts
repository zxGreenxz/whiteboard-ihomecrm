// Nghe extension báo "cổng vừa nhận hồ sơ" rồi ghi mã vào sổ NGAY, không cần
// người dùng chuyển về tab CRM hay mở đúng chi tiết khách.
//
// VÌ SAO PHẢI QUA CRM CHỨ EXTENSION KHÔNG TỰ GHI: phiên đăng nhập nằm ở trang
// CRM, extension không có và không nên có. Nhưng tab CRM vẫn chạy khi ở nền, nên
// chỉ cần extension đánh thức nó là ghi được ngay — người dùng không phải làm gì.
//
// TÍN HIỆU ĐI QUA window, DỮ LIỆU THÌ KHÔNG: bridge.js chỉ phát một tiếng "có cái
// mới", còn mã hồ sơ thì trang tự hỏi extension qua chrome.runtime.sendMessage.
// Ai giả được tiếng gõ cửa cũng chỉ làm ta hỏi thừa một lượt, không chèn được mã rác.
import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ghiHoSoTamTru, maHoSoHopLe } from '@/lib/residenceRegistrations';
import { residenceRegistrationKeys } from '@/hooks/useResidenceRegistrations';
import { layKetQuaNop, xacNhanDaGhiSo, type KetQuaNopTamTru } from '@/lib/tamTruBridge';

export const TAM_TRU_TIN_HIEU = 'IHOME_TAMTRU_CO_KET_QUA';

/** Đủ dữ liệu để ghi thẳng vào sổ mà không cần màn hình nào đang mở. */
function duDeGhi(k: KetQuaNopTamTru): k is KetQuaNopTamTru & { buildingId: string; organizationId: string } {
  return maHoSoHopLe(k.submCode) && !!k.customerId && !!k.buildingId && !!k.organizationId;
}

export function useTamTruKetQuaSync(): void {
  const queryClient = useQueryClient();
  const dangChay = useRef(false);

  const dongBo = useCallback(async () => {
    if (dangChay.current) return;
    dangChay.current = true;
    try {
      let ds: KetQuaNopTamTru[] = [];
      try {
        ds = await layKetQuaNop();
      } catch {
        return; // Extension chưa cài hoặc không trả lời: bình thường, không phải lỗi.
      }
      const daGhi: string[] = [];
      for (const k of ds.filter(duDeGhi)) {
        try {
          await ghiHoSoTamTru({
            customerId: k.customerId, buildingId: k.buildingId, organizationId: k.organizationId,
            contractId: k.contractId ?? null, submCode: k.submCode, receiveOrg: k.receiveOrg,
            tempResidentFrom: k.tempResidentFrom, tempResidentTo: k.tempResidentTo, submittedAt: k.submittedAt,
          });
          daGhi.push(k.submCode);
          await queryClient.invalidateQueries({ queryKey: residenceRegistrationKeys.customer(k.customerId) });
        } catch {
          // Ghi hụt (mất mạng, hết phiên): giữ nguyên trong extension để lần sau ghi tiếp.
        }
      }
      if (daGhi.length > 0) {
        toast.success(daGhi.length === 1
          ? `Đã ghi mã hồ sơ ${daGhi[0]} vào hồ sơ khách.`
          : `Đã ghi ${daGhi.length} mã hồ sơ tạm trú vào hồ sơ khách.`);
        try { await xacNhanDaGhiSo(daGhi); } catch { /* lần sau hỏi lại; sổ chốt trùng theo mã nên không đẻ dòng mới */ }
      }
    } finally {
      dangChay.current = false;
    }
  }, [queryClient]);

  useEffect(() => {
    const khiCoTin = (ev: MessageEvent) => {
      if (ev.source !== window || !ev.data || ev.data.type !== TAM_TRU_TIN_HIEU) return;
      void dongBo();
    };
    // Quay lại tab cũng là một dịp: tab CRM có thể đã bị đóng lúc nộp, hoặc
    // trình duyệt ngủ đông làm tin nhắn không tới.
    const khiHien = () => { if (document.visibilityState === 'visible') void dongBo(); };
    window.addEventListener('message', khiCoTin);
    window.addEventListener('focus', khiHien);
    document.addEventListener('visibilitychange', khiHien);
    void dongBo();
    return () => {
      window.removeEventListener('message', khiCoTin);
      window.removeEventListener('focus', khiHien);
      document.removeEventListener('visibilitychange', khiHien);
    };
  }, [dongBo]);
}

/** Bọc thành component để cắm vào cây provider như các listener realtime khác. */
export function TamTruKetQuaSync(): null {
  useTamTruKetQuaSync();
  return null;
}
