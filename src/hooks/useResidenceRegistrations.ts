// Sổ đăng ký tạm trú của một khách + việc lấy mã hồ sơ extension giữ hộ sau khi nộp.
//
// Extension không ghi được vào cơ sở dữ liệu (nó không có phiên đăng nhập), nên nó
// giữ mã trong bộ nhớ của chính nó cho tới khi CRM mở ra hỏi. CRM ghi xong thì báo
// lại để extension xoá — không xoá trước, kẻo ghi hụt là mất mã.
import { useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ghiHoSoTamTru, listCustomerRegistrations, maHoSoHopLe,
  type GhiHoSoInput, type ResidenceRegistration,
} from '@/lib/residenceRegistrations';
import { layKetQuaNop, xacNhanDaGhiSo, type KetQuaNopTamTru } from '@/lib/tamTruBridge';

export const residenceRegistrationKeys = {
  customer: (customerId: string) => ['residence-registrations', customerId] as const,
};

export function useCustomerRegistrations(customerId: string | undefined) {
  return useQuery<ResidenceRegistration[], Error>({
    queryKey: residenceRegistrationKeys.customer(customerId ?? ''),
    queryFn: () => listCustomerRegistrations(customerId as string),
    enabled: !!customerId,
  });
}

export function useGhiHoSoTamTru(customerId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation<ResidenceRegistration, Error, GhiHoSoInput>({
    mutationFn: ghiHoSoTamTru,
    onSuccess: async () => {
      if (customerId) await queryClient.invalidateQueries({ queryKey: residenceRegistrationKeys.customer(customerId) });
    },
    onError: (error) => toast.error(error.message),
  });
}

export interface NhanKetQuaScope {
  customerId: string;
  buildingId: string;
  organizationId: string;
  contractId?: string | null;
}

/**
 * Hỏi extension xem có mã hồ sơ nào vừa nộp mà chưa ghi sổ không, rồi ghi.
 * Chỉ nhận mã của ĐÚNG khách đang mở: gói của khách khác để nguyên cho lần sau,
 * vì ghi nhầm mã sang khách khác thì không ai phát hiện được.
 */
export function useNhanKetQuaNop(scope: NhanKetQuaScope | null) {
  const ghi = useGhiHoSoTamTru(scope?.customerId);
  const ghiRef = ghi.mutateAsync;

  const dongBo = useCallback(async () => {
    if (!scope?.customerId || !scope.buildingId || !scope.organizationId) return;
    let ketQua: KetQuaNopTamTru[] = [];
    try {
      ketQua = await layKetQuaNop();
    } catch {
      // Extension chưa cài hoặc không trả lời: không có gì để ghi, và đó là bình thường.
      return;
    }
    const cuaKhach = ketQua.filter((k) => k.customerId === scope.customerId && maHoSoHopLe(k.submCode));
    const daGhi: string[] = [];
    for (const k of cuaKhach) {
      try {
        await ghiRef({
          customerId: scope.customerId, buildingId: scope.buildingId, organizationId: scope.organizationId,
          contractId: scope.contractId ?? null, submCode: k.submCode, receiveOrg: k.receiveOrg,
          tempResidentFrom: k.tempResidentFrom, tempResidentTo: k.tempResidentTo, submittedAt: k.submittedAt,
        });
        daGhi.push(k.submCode);
      } catch {
        // Mutation đã toast; giữ lại trong extension để thử lần sau.
      }
    }
    if (daGhi.length > 0) {
      toast.success(daGhi.length === 1 ? `Đã ghi mã hồ sơ ${daGhi[0]} vào hồ sơ khách.` : `Đã ghi ${daGhi.length} mã hồ sơ vào hồ sơ khách.`);
      try { await xacNhanDaGhiSo(daGhi); } catch { /* lần sau hỏi lại, upsert theo mã nên không đẻ trùng */ }
    }
  }, [scope?.customerId, scope?.buildingId, scope?.organizationId, scope?.contractId, ghiRef]);

  // Hỏi khi mở khối và mỗi lần quay lại tab CRM (người dùng nộp xong ở tab cổng rồi quay về).
  useEffect(() => {
    void dongBo();
    const khiHien = () => { if (document.visibilityState === 'visible') void dongBo(); };
    window.addEventListener('focus', khiHien);
    document.addEventListener('visibilitychange', khiHien);
    return () => {
      window.removeEventListener('focus', khiHien);
      document.removeEventListener('visibilitychange', khiHien);
    };
  }, [dongBo]);

  return { dongBo, dangGhi: ghi.isPending };
}
