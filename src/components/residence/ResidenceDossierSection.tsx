// Khối "Hồ sơ tạm trú" trong chi tiết khách: ảnh CT01 và hợp đồng đã ký của khách,
// trạng thái giấy chỗ ở hợp pháp của toà, và nút gửi sang Cổng DVC.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { loadCT01Tenancies, type CT01Tenancy } from '@/lib/ct01DownloadService';
import { useBuildingOwnershipFiles, useCustomerDossierFiles, useDossierFileMutations } from '@/hooks/useResidenceDossierFiles';
import { useLeaseTermOcr } from '@/hooks/useLeaseTermOcr';
import type { TamTruCustomerInput } from '@/lib/tamTruPayload';
import DossierImageUploader from './DossierImageUploader';
import LeaseTermBadge from './LeaseTermBadge';
import TamTruDvcButton from './TamTruDvcButton';

export interface ResidenceDossierSectionProps { customer: TamTruCustomerInput }

export default function ResidenceDossierSection({ customer }: ResidenceDossierSectionProps) {
  const { data: permissions } = useMyPermissions();
  const allowed = canUse(permissions, 'customers', 'print');
  const tenancies = useQuery<CT01Tenancy[], Error>({
    queryKey: ['ct01-tenancies', customer.id],
    queryFn: () => loadCT01Tenancies(customer.id),
    enabled: allowed,
  });
  const [roomId, setRoomId] = useState<string>('');
  useEffect(() => {
    const list = tenancies.data ?? [];
    if (list.length > 0 && !list.some(t => t.roomId === roomId)) setRoomId(list[0].roomId);
  }, [tenancies.data, roomId]);
  const tenancy = useMemo(() => (tenancies.data ?? []).find(t => t.roomId === roomId) ?? null, [tenancies.data, roomId]);

  const customerFiles = useCustomerDossierFiles(allowed ? customer.id : undefined);
  const ownershipFiles = useBuildingOwnershipFiles(tenancy?.building.id);
  const { upload, remove, luuHan } = useDossierFileMutations({
    customerId: customer.id, buildingId: tenancy?.building.id ?? '',
    buildingName: tenancy?.building.name, customerName: customer.full_name,
  });

  const files = useMemo(() => customerFiles.data ?? [], [customerFiles.data]);
  // Anh hop dong cua dung hop dong dang chon, moi nhat truoc - chinh anh se gui di.
  const leaseFile = useMemo(() => {
    const lease = files.filter(f => f.kind === 'LEASE');
    const theoHopDong = lease.filter(f => f.contract_id === tenancy?.contractId);
    return (theoHopDong.length > 0 ? theoHopDong : lease).at(-1);
  }, [files, tenancy?.contractId]);
  const hopDong = useLeaseTermOcr(leaseFile, allowed);

  if (!allowed) return null;

  const ownership = ownershipFiles.data ?? [];

  return (
    <section className="space-y-3" aria-label="Hồ sơ tạm trú">
      <h3 className="text-sm font-semibold">Hồ sơ tạm trú (Cổng DVC Bộ Công an)</h3>
      {tenancies.isLoading && <p className="text-xs text-muted-foreground">Đang tải hợp đồng đang ở…</p>}
      {tenancies.isError && <p className="text-xs text-red-600">Không tải được hợp đồng đang ở. Vui lòng thử lại.</p>}
      {tenancies.data && tenancies.data.length === 0 && (
        <p className="text-xs text-muted-foreground">Khách chưa có hợp đồng đang ở, chưa thể lập hồ sơ tạm trú.</p>
      )}
      {tenancies.data && tenancies.data.length > 1 && (
        <label className="flex items-center gap-2 text-sm">
          Phòng kê khai
          <select aria-label="Phòng kê khai tạm trú" value={roomId} onChange={(e) => setRoomId(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            {tenancies.data.map(t => (
              <option key={t.roomId} value={t.roomId}>{t.building.name} · Phòng {t.roomNumber}</option>
            ))}
          </select>
        </label>
      )}
      {tenancy && (
        <>
          <DossierImageUploader kind="CT01" files={files.filter(f => f.kind === 'CT01')} canEdit contractId={tenancy.contractId}
            onUpload={upload.mutateAsync} onRemove={remove.mutateAsync}
            hint="Chụp hoặc tải ảnh tờ khai CT01 đã ký. Có thể tải ngay từ điện thoại." />
          <DossierImageUploader kind="LEASE" files={files.filter(f => f.kind === 'LEASE')} canEdit contractId={tenancy.contractId}
            onUpload={upload.mutateAsync} onRemove={remove.mutateAsync}>
            <LeaseTermBadge trangThai={hopDong.trangThai} han={hopDong.han} coAnh={!!leaseFile} canEdit
              onDocLai={hopDong.docLai}
              onSua={(from, to) => { if (leaseFile) void luuHan.mutateAsync({ id: leaseFile.id, from, to, nguon: 'manual' }); }} />
          </DossierImageUploader>
          <p className="flex items-center gap-1.5 text-xs">
            {ownership.length > 0
              ? <><CheckCircle2 className="h-4 w-4 text-green-600" /> Giấy tờ chỗ ở hợp pháp của toà {tenancy.building.name}: {ownership.length} ảnh.</>
              : <><AlertTriangle className="h-4 w-4 text-amber-600" /> Toà {tenancy.building.name} chưa có ảnh giấy tờ chỗ ở hợp pháp. Bổ sung trong Sửa toà nhà.</>}
          </p>
          <TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={files} ownershipFiles={ownership}
            tempResidentTo={hopDong.han?.to ?? null} />
        </>
      )}
    </section>
  );
}
