// Khối "Hồ sơ tạm trú" trong chi tiết khách: ảnh CT01 và hợp đồng đã ký của khách,
// trạng thái giấy chỗ ở hợp pháp của toà, và hàng thao tác cuối cùng gồm thời hạn
// tạm trú (dùng chung cho cả tải giấy lẫn nộp DVC), nút tải giấy và nút gửi sang Cổng DVC.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { loadCT01Tenancies, type CT01Tenancy } from '@/lib/ct01DownloadService';
import { useBuildingOwnershipFiles, useCustomerDossierFiles, useDossierFileMutations } from '@/hooks/useResidenceDossierFiles';
import { useLeaseTermOcr } from '@/hooks/useLeaseTermOcr';
import { congThang, ngayHopLe, type HanHopDong } from '@/lib/residenceLeaseTerm';
import type { ResidenceDossierFile } from '@/lib/residenceDossierFiles';
import type { CT01Customer } from '@/lib/ct01Document';
import type { TamTruCustomerInput } from '@/lib/tamTruPayload';
import CT01DownloadButton from '@/components/customers/CT01DownloadButton';
import DossierImageUploader from './DossierImageUploader';
import LeaseTermBadge from './LeaseTermBadge';
import TamTruDvcButton from './TamTruDvcButton';

// Khối cần đủ dữ liệu cho cả gói gửi Cổng DVC lẫn tờ khai CT01 tải về.
export interface ResidenceDossierSectionProps { customer: TamTruCustomerInput & CT01Customer }

const hai = (n: number) => String(n).padStart(2, '0');

/** yyyy-mm-dd (Postgres) hoặc ISO datetime → dd/mm/yyyy. */
function vnNgay(raw: string | null | undefined): string | null {
  const m = raw?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/**
 * Ngày ký hợp đồng ở nhờ, theo thứ tự tin cậy giảm dần: đọc được trên ảnh →
 * ngày tải ảnh lên (chủ in giấy ra ký đúng hôm đó) → hôm nay.
 */
export function ngayKyHopDong(han: HanHopDong | null, anh: ResidenceDossierFile | undefined, homNay: Date = new Date()): string {
  if (han?.from) return han.from;
  const theoAnh = vnNgay(anh?.created_at);
  if (theoAnh) return theoAnh;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(homNay);
  const lay = (t: Intl.DateTimeFormatPartTypes) => p.find(x => x.type === t)?.value ?? '';
  return `${lay('day')}/${lay('month')}/${lay('year')}`;
}

/** dd/mm/yyyy + số tháng → dd/mm/yyyy. */
export function hanTheoThang(tuNgay: string, thang: 12 | 24): string {
  const [d, m, y] = tuNgay.split('/');
  const goc = d && m && y ? ngayHopLe(Number(d), Number(m), Number(y)) : null;
  if (!goc) return '';
  const den = congThang(goc, thang);
  return `${hai(den.getUTCDate())}/${hai(den.getUTCMonth() + 1)}/${den.getUTCFullYear()}`;
}

/** Số tháng suy từ cặp ngày đã lưu, để ô chọn hiện đúng thứ chủ đã chốt lần trước. */
export function thangTheoHan(han: HanHopDong | null): 12 | 24 | null {
  if (!han) return null;
  if (han.months === 12 || han.months === 24) return han.months;
  return hanTheoThang(han.from, 12) === han.to ? 12 : hanTheoThang(han.from, 24) === han.to ? 24 : null;
}

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
    const dau = list[0];
    if (dau && !list.some(t => t.roomId === roomId)) setRoomId(dau.roomId);
  }, [tenancies.data, roomId]);
  const tenancy = useMemo(() => (tenancies.data ?? []).find(t => t.roomId === roomId) ?? null, [tenancies.data, roomId]);

  const customerFiles = useCustomerDossierFiles(allowed ? customer.id : undefined);
  const ownershipFiles = useBuildingOwnershipFiles(tenancy?.building.id);
  const { upload, remove, luuHan } = useDossierFileMutations({
    customerId: customer.id, buildingId: tenancy?.building.id ?? '',
    buildingName: tenancy?.building.name, customerName: customer.full_name,
  });

  const files = useMemo(() => customerFiles.data ?? [], [customerFiles.data]);
  // Ảnh hợp đồng của đúng hợp đồng đang chọn, mới nhất trước — chính ảnh sẽ gửi đi.
  const leaseFile = useMemo(() => {
    const lease = files.filter(f => f.kind === 'LEASE');
    const theoHopDong = lease.filter(f => f.contract_id === tenancy?.contractId);
    return (theoHopDong.length > 0 ? theoHopDong : lease).at(-1);
  }, [files, tenancy?.contractId]);
  const hopDong = useLeaseTermOcr(leaseFile, allowed);

  // Số tháng: lấy lại từ hạn đã lưu trên ảnh (chủ chốt lần trước), mặc định 24.
  const [thangChon, setThangChon] = useState<12 | 24 | null>(null);
  const thangDaLuu = thangTheoHan(hopDong.han);
  const durationMonths: 12 | 24 = thangChon ?? thangDaLuu ?? 24;
  const ngayKy = ngayKyHopDong(hopDong.han, leaseFile);
  // Hạn đọc thẳng từ giấy thắng mọi phép tính; không đọc được thì tính từ ngày ký.
  const hanDen = hopDong.han?.to ?? hanTheoThang(ngayKy, durationMonths);

  const doiThang = (thang: 12 | 24) => {
    setThangChon(thang);
    const den = hanTheoThang(ngayKy, thang);
    // Ghi lại ngay để lần sau mở hồ sơ vẫn đúng thứ chủ đã chọn.
    if (leaseFile && den) void luuHan.mutateAsync({ id: leaseFile.id, from: ngayKy, to: den, nguon: 'manual' });
  };

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
          <div className="flex flex-wrap items-center gap-3 border-t pt-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Thời hạn tạm trú
              <select aria-label="Thời hạn tạm trú" value={durationMonths}
                onChange={(e) => doiThang(e.target.value === '12' ? 12 : 24)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground">
                <option value="12">12 tháng</option>
                <option value="24">24 tháng</option>
              </select>
            </label>
            <span className="text-sm text-muted-foreground">
              {ngayKy} → <b className="text-foreground">{hanDen}</b>
            </span>
            <CT01DownloadButton customer={customer} durationMonths={durationMonths} gonNhe />
            <TamTruDvcButton customer={customer} tenancy={tenancy} customerFiles={files} ownershipFiles={ownership}
              tempResidentFrom={ngayKy} tempResidentTo={hanDen} />
          </div>
        </>
      )}
    </section>
  );
}
