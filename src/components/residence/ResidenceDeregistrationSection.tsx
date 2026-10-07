// Khối "Huỷ đăng ký tạm trú" trong chi tiết khách, ngay dưới khối đăng ký: mặc định
// thu gọn (chỉ cần khi khách trả phòng), bấm mũi tên mới mở và mới tải dữ liệu.
// Giống khối đăng ký nhưng không có thời hạn: ảnh CT01 huỷ + biên bản thanh lý đã ký,
// nút tải giấy, nút gửi sang Cổng DVC và ô ghi tay mã hồ sơ.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { loadCT01XoaTenancies, type CT01XoaTenancy } from '@/lib/ct01DownloadService';
import { useCustomerDossierFiles, useDossierFileMutations } from '@/hooks/useResidenceDossierFiles';
import { useCustomerRegistrations, useGhiHoSoTamTru } from '@/hooks/useResidenceRegistrations';
import { ngayVn, theoThuTuc } from '@/lib/residenceRegistrations';
import type { CT01Customer } from '@/lib/ct01Document';
import type { TamTruCustomerInput } from '@/lib/tamTruPayload';
import { QueryRegion } from '@/components/errors/QueryRegion';
import DossierImageUploader from './DossierImageUploader';
import RegistrationHistory from './RegistrationHistory';
import RegistrationManualEntry from './RegistrationManualEntry';
import CT01HuyDownloadButton from './CT01HuyDownloadButton';
import TamTruXoaDvcButton from './TamTruXoaDvcButton';

export interface ResidenceDeregistrationSectionProps { customer: TamTruCustomerInput & CT01Customer }

const TRANG_THAI: Record<string, string> = {
  ACTIVE: 'đang ở', EXTENDED: 'đang ở', TERMINATED: 'đã thanh lý', EXPIRED: 'hết hạn', TRANSFERRED: 'đã chuyển phòng',
};

function ngayThanhLy(t: CT01XoaTenancy): string {
  return t.endDate ? `${ngayVn(t.endDate)} (theo hợp đồng)` : 'ngày tải giấy (hợp đồng chưa có ngày kết thúc)';
}

export default function ResidenceDeregistrationSection({ customer }: ResidenceDeregistrationSectionProps) {
  const [mo, setMo] = useState(false);
  const tenancies = useQuery<CT01XoaTenancy[], Error>({
    queryKey: ['ct01-xoa-tenancies', customer.id],
    queryFn: () => loadCT01XoaTenancies(customer.id),
    enabled: mo,
  });
  const [roomId, setRoomId] = useState('');
  useEffect(() => {
    const list = tenancies.data ?? [];
    const dau = list[0];
    if (dau && !list.some(t => t.roomId === roomId)) setRoomId(dau.roomId);
  }, [tenancies.data, roomId]);
  const tenancy = useMemo(() => (tenancies.data ?? []).find(t => t.roomId === roomId) ?? null, [tenancies.data, roomId]);

  const customerFiles = useCustomerDossierFiles(mo ? customer.id : undefined);
  const { upload, remove } = useDossierFileMutations({
    customerId: customer.id, buildingId: tenancy?.building.id ?? '',
    buildingName: tenancy?.building.name, customerName: customer.full_name,
  });
  const files = useMemo(() => customerFiles.data ?? [], [customerFiles.data]);
  const dangKy = useCustomerRegistrations(mo ? customer.id : undefined);
  const daXoa = theoThuTuc(dangKy.data ?? [], 'TAMTRU_06');
  const ghiMa = useGhiHoSoTamTru(customer.id);

  return (
    <section className="space-y-3 border-t pt-3" aria-label="Huỷ đăng ký tạm trú">
      <button type="button" onClick={() => setMo(v => !v)} aria-expanded={mo} aria-controls="huy-tam-tru-noi-dung"
        className="flex w-full items-center gap-1.5 text-left text-sm font-semibold hover:text-foreground/80">
        {mo ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Huỷ đăng ký tạm trú (Cổng DVC Bộ Công an)
      </button>
      {mo && (
        <div id="huy-tam-tru-noi-dung" className="space-y-3">
          <QueryRegion label="hồ sơ huỷ tạm trú" queries={[tenancies, customerFiles, dangKy]} skeleton="detail" rows={3}>
            {tenancies.data && tenancies.data.length === 0 && (
              <p className="text-xs text-muted-foreground">Khách chưa có hợp đồng nào, chưa thể lập hồ sơ huỷ tạm trú.</p>
            )}
            {tenancies.data && tenancies.data.length > 1 && (
              <label className="flex items-center gap-2 text-sm">
                Phòng huỷ tạm trú
                <select aria-label="Phòng huỷ tạm trú" value={roomId} onChange={(e) => setRoomId(e.target.value)}
                  className="h-9 rounded-md border border-input bg-background px-2 text-sm">
                  {tenancies.data.map(t => (
                    <option key={t.roomId} value={t.roomId}>
                      {t.building.name} · Phòng {t.roomNumber} · {TRANG_THAI[t.contractStatus] ?? t.contractStatus}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {tenancy && (
              <>
                <p className="text-xs text-muted-foreground">
                  Toà {tenancy.building.name} · Phòng {tenancy.roomNumber} · ngày thanh lý ghi trên biên bản: {ngayThanhLy(tenancy)}
                </p>
                <DossierImageUploader kind="CT01_XOA" files={files.filter(f => f.kind === 'CT01_XOA')} canEdit contractId={tenancy.contractId}
                  onUpload={upload.mutateAsync} onRemove={remove.mutateAsync}
                  hint="Chụp hoặc tải ảnh tờ khai CT01 huỷ tạm trú đã ký." />
                <DossierImageUploader kind="THANH_LY" files={files.filter(f => f.kind === 'THANH_LY')} canEdit contractId={tenancy.contractId}
                  onUpload={upload.mutateAsync} onRemove={remove.mutateAsync}
                  hint="Chụp hoặc tải ảnh biên bản thanh lý đã có đủ chữ ký hai bên." />
                {daXoa.length > 0 && <RegistrationHistory registrations={daXoa} nhan="Đã huỷ tạm trú" nhanLichSu="Lịch sử huỷ tạm trú" />}
                <div className="flex flex-wrap items-center gap-3 border-t pt-3">
                  <CT01HuyDownloadButton customer={customer} tenancy={tenancy} />
                  <TamTruXoaDvcButton customer={customer} tenancy={tenancy} customerFiles={files} />
                  <RegistrationManualEntry dangGhi={ghiMa.isPending} onGhi={(submCode) => ghiMa.mutateAsync({
                    customerId: customer.id, buildingId: tenancy.building.id,
                    organizationId: tenancy.building.organization_id ?? '', contractId: tenancy.contractId,
                    submCode, procedureCode: 'TAMTRU_06', receiveOrg: '',
                  })} />
                </div>
              </>
            )}
          </QueryRegion>
        </div>
      )}
    </section>
  );
}
