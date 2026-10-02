import type { UseFormReturn } from 'react-hook-form';
import { useContractRentSupport } from '@/hooks/useContractRentSupport';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { LoadingState } from '@/components/loading/LoadingState';
import type { ContractFormData } from '@/lib/contractValidation';
import type { SupportCustomerSchedule } from '@/lib/rentSupport';
import { RentSupportScheduleEditor } from './RentSupportScheduleEditor';

export function ConnectedRentSupportScheduleEditor({ form, buildingId, contractId, readonlySchedule, signed }: {
  form: UseFormReturn<ContractFormData>; buildingId: string; contractId?: string;
  readonlySchedule?: SupportCustomerSchedule; signed?: boolean;
}) {
  const { data: permissions } = useMyPermissions();
  const canView = canUse(permissions, 'income_expenses', 'view', buildingId);
  const read = useContractRentSupport({ contractIds: contractId ? [contractId] : [], enabled: !!contractId && signed });
  const schedule = readonlySchedule ?? read.data?.rows.find(row => row.contract_id === contractId)?.schedule ?? undefined;
  // Chưa có dữ liệu (không lỗi): khối xám thay chữ "Đang tải…" — chủ chốt 02/10/2026.
  if (signed && !schedule && !read.isError && !read.data) return <LoadingState label="lịch hỗ trợ đã ký" rows={3} />;
  if (signed && !schedule) return <p role="status" className="text-sm">{read.isError ? 'Chưa đọc được lịch hỗ trợ đã ký. Không sửa lịch qua biểu mẫu này.' : 'Hợp đồng chưa có lịch hỗ trợ v2. Thay lịch đã ký cần luồng điều chỉnh có phiên bản và lý do.'}</p>;
  return <RentSupportScheduleEditor form={form} readonlySchedule={schedule} disabled={signed || !canView} canEditFunding={canView} />;
}
