// Sổ đăng ký tạm trú của một khách: đọc danh sách và ghi một lần nộp.
//
// Việc LẤY mã từ extension nằm ở src/hooks/useTamTruKetQuaSync.ts — nó chạy ở tầng
// app nên ghi được ngay khi extension gõ cửa, kể cả lúc không màn nào đang mở.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ghiHoSoTamTru, listCustomerRegistrations, RegistrationError,
  type GhiHoSoInput, type ResidenceRegistration,
} from '@/lib/residenceRegistrations';
import { FinancialWorkflowError } from '@/lib/financialWorkflowError';
import { recordWriteMessage } from '@/lib/recordWriteOutcome';
import { friendlyError } from '@/lib/friendlyError';

import { residenceRegistrationKeys } from '@/lib/residenceRegistrationKeys';
export { residenceRegistrationKeys } from '@/lib/residenceRegistrationKeys';

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
    onError: (error) => toast.error(error instanceof FinancialWorkflowError ? recordWriteMessage(error, 'lưu mã hồ sơ tạm trú') : error instanceof RegistrationError
      ? error.message
      : friendlyError(error, 'Chưa lưu được mã hồ sơ tạm trú', { operation: 'lưu mã hồ sơ tạm trú' }).description),
  });
}
