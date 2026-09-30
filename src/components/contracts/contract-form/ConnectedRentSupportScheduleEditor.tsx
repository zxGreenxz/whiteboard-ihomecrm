import { useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { useRentSupportParties } from '@/hooks/useRentSupportParties';
import { useContractRentSupport } from '@/hooks/useContractRentSupport';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type { ContractFormData } from '@/lib/contractValidation';
import type { SupportCustomerSchedule } from '@/lib/rentSupport';
import { RentSupportScheduleEditor } from './RentSupportScheduleEditor';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function ConnectedRentSupportScheduleEditor({ form, buildingId, contractId, readonlySchedule, signed }: {
  form: UseFormReturn<ContractFormData>; buildingId: string; contractId?: string;
  readonlySchedule?: SupportCustomerSchedule; signed?: boolean;
}) {
  const { data: permissions } = useMyPermissions();
  const canView = canUse(permissions, 'income_expenses', 'view', buildingId);
  const canRegister = canUse(permissions, 'income_expenses', 'create', buildingId);
  const sale = form.watch('rent_support')?.payer === 'SALE';
  const parties = useRentSupportParties(buildingId, sale && canView && !signed && !readonlySchedule);
  const read = useContractRentSupport({ contractIds: contractId ? [contractId] : [], enabled: !!contractId && signed });
  const [error, setError] = useState('');
  const [name, setName] = useState(''), [reason, setReason] = useState('');
  const intent = useRef<{ key: string; requestId: string }>();
  const scope = useRef(buildingId); scope.current = buildingId;
  const register = async (profileId: string | null, displayName: string, verificationReason: string) => {
    if (!canRegister) { setError('Bạn cần quyền tạo thu chi để xác minh danh tính mới.'); return ''; }
    const key = JSON.stringify([buildingId, profileId, displayName, verificationReason]);
    if (intent.current?.key !== key) intent.current = { key, requestId: crypto.randomUUID() };
    try {
      setError('');
      const party = await parties.register.mutateAsync({ profileId, displayName, reason: verificationReason, requestId: intent.current.requestId });
      return scope.current === buildingId && form.getValues('rent_support')?.payer === 'SALE' ? party.party_id : '';
    } catch (failure) {
      const code = typeof failure === 'object' && failure !== null && 'code' in failure ? String(failure.code) : '';
      setError(code === '42501' ? 'Không có quyền xác minh danh tính trong toà này. Kiểm tra phân quyền hoặc tư cách nhân sự.'
        : code === 'PT409' ? 'Danh tính hoặc lần xác minh đã thay đổi. Kiểm tra nội dung rồi chọn lại.'
        : 'Không xác minh được danh tính. Kiểm tra quyền và phạm vi toà rồi thử lại.');
      return '';
    }
  };
  const schedule = readonlySchedule ?? read.data?.rows.find(row => row.contract_id === contractId)?.schedule ?? undefined;
  if (signed && !schedule) return <p role="status" className="text-sm">{read.isError ? 'Chưa đọc được lịch hỗ trợ đã ký. Không sửa lịch qua biểu mẫu này.' : read.data ? 'Hợp đồng chưa có lịch hỗ trợ v2. Thay lịch đã ký cần luồng điều chỉnh có phiên bản và lý do.' : 'Đang tải lịch hỗ trợ đã ký…'}</p>;
  return <>
    <RentSupportScheduleEditor form={form} parties={parties.data ?? []} readonlySchedule={schedule} disabled={signed || parties.register.isPending || !canView} canEditFunding={canView}
      partyLoading={parties.isFetching} partyError={error || (sale && !canView ? 'Bạn cần quyền xem tài chính để chọn Sale.' : parties.isError ? 'Chưa tải được danh tính trong toà. Thử tải lại.' : undefined)}
      onSelectParty={party => register(party.profile_id, party.display_name, 'Xác minh nhân sự đang hoạt động khi chọn người chịu hỗ trợ tiền thuê.')} />
    {sale && !signed && !readonlySchedule && canRegister && <div className="space-y-2 rounded border p-3">
      <p className="text-xs">Người nhận ngoài nhân sự: xác minh rõ danh tính và lý do trước khi đăng ký.</p>
      <Input aria-label="Tên người nhận ngoài nhân sự" placeholder="Họ tên đã xác minh" value={name} onChange={event => setName(event.target.value)}/>
      <Input aria-label="Lý do xác minh danh tính" placeholder="Lý do và bằng chứng xác minh" value={reason} onChange={event => setReason(event.target.value)}/>
      <Button type="button" variant="outline" disabled={!name.trim() || !reason.trim() || parties.register.isPending} onClick={async () => {
        const id = await register(null, name, reason); const current = form.getValues('rent_support');
        if (id && current) form.setValue('rent_support', { ...current, sale_party_id: id }, { shouldDirty: true, shouldValidate: true });
      }}>Xác minh và chọn người nhận</Button>
    </div>}
  </>;
}
