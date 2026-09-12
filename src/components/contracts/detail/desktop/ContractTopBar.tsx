// Header đen dính đầu màn chi tiết hợp đồng (desktop bản mới).
//
// Gộp hai thứ bản cũ để rời nhau: dải nút hành động (ContractActionBar) và bốn
// con số phải liếc là thấy (phòng, giá, hiệu lực, thời hạn). Dính theo cuộn nên
// cuộn xuống bảng tiền vẫn biết đang xem HĐ nào và bấm hành động được ngay.
//
// BẢNG QUYỀN Ở ĐÂY CHÉP NGUYÊN từ ContractActionBar — không diễn giải lại. Mỗi
// dòng `canUse(...)` bên dưới là một điều kiện đã chạy trên production.

import {
  ArrowRightLeft,
  Calendar,
  MoveRight,
  Pencil,
  Printer,
  QrCode,
  RefreshCw,
  Trash2,
  X,
  XCircle,
  FileText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ContractWithRelations } from '@/hooks/useContracts';
import { canUse } from '@/lib/permissionPages';
import { formatAmount } from '@/components/contracts/detail/formatCurrency';
import { chipTrangThai, nhanThoiHan, tienDoHopDong } from './contractHeaderStats';

/**
 * Khung căn giữa DÙNG CHUNG cho cả hai tầng header và thân trang.
 *
 * VÌ SAO KHÔNG CÒN TRẦN 1720px (sửa 13/09): bản thiết kế vẽ ở khổ 1440 nên trần
 * đó không bao giờ chạm tới. Trên màn thật rộng — hoặc chỉ cần người dùng thu
 * phóng nhỏ lại, viewport CSS tăng lên — trần kẹp nội dung ở 1720px rồi đẩy nó
 * vào giữa, trong khi nền đen của header vẫn tràn hết bề ngang. Đo được ở
 * viewport 2560: vùng dùng được 2296px nhưng chỉ xài 1720px, bỏ trống 288px mỗi
 * bên. Chủ mô tả đúng hiện tượng: "nhìn lạc lõng, không tự resize theo màn hình".
 *
 * Trần 2400px giữ lại chỉ để chặn màn siêu rộng (ultrawide 3440+) kéo một dòng
 * dài quá tầm mắt; mọi màn thường dùng đều nằm dưới ngưỡng này nên thực tế là
 * "luôn lấp đầy".
 */
export const KHUNG = 'mx-auto w-full max-w-[2400px] px-[var(--px)]';

const CHU_KY: Record<string, string> = {
  MONTHLY: 'hàng tháng',
  QUARTERLY: 'hàng quý',
  SEMI_ANNUAL: '6 tháng',
  ANNUAL: 'hàng năm',
};

const ngayVn = (gt: string | null | undefined): string => {
  if (!gt) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(gt);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : gt;
};

function NutHeader({
  icon: Icon,
  nhan,
  onClick,
  doTuoi = false,
}: {
  icon: LucideIcon;
  nhan: string;
  onClick: () => void;
  doTuoi?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        doTuoi
          ? 'inline-flex h-[34px] items-center gap-2 whitespace-nowrap rounded-md border border-[#dc2626] bg-[#dc2626] px-3 text-[13.5px] font-semibold text-white transition-colors hover:border-[#b91c1c] hover:bg-[#b91c1c]'
          : 'inline-flex h-[34px] items-center gap-2 whitespace-nowrap rounded-md border border-white/[.16] bg-white/[.06] px-2.5 text-[13.5px] font-medium text-[#e6ede9] transition-colors hover:bg-white/[.14]'
      }
    >
      <Icon className="h-4 w-4" strokeWidth={2} />
      {nhan}
    </button>
  );
}

function OChiSo({
  nhan,
  children,
  className,
}: {
  nhan: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-[.07em] text-white/45">
        {nhan}
      </div>
      {children}
    </div>
  );
}

interface Props {
  contract: ContractWithRelations;
  perms: Parameters<typeof canUse>[0];
  isActive: boolean;
  outstandingAmount: number;
  daysRemaining: number;
  totalDays: number;
  daysElapsed: number;
  onBack: () => void;
  onEdit: () => void;
  onPrint: () => void;
  onShowQR: () => void;
  onRenew: () => void;
  onTransferRoom: () => void;
  onTransferContract: () => void;
  onMoveOut: () => void;
  onTerminate: () => void;
  onDelete: () => void;
}

export function ContractTopBar({
  contract,
  perms,
  isActive,
  outstandingAmount,
  daysRemaining,
  totalDays,
  daysElapsed,
  onBack,
  onEdit,
  onPrint,
  onShowQR,
  onRenew,
  onTransferRoom,
  onTransferContract,
  onMoveOut,
  onTerminate,
  onDelete,
}: Props) {
  const chip = chipTrangThai(contract.status);
  const tienDo = tienDoHopDong(totalDays, daysElapsed);
  const thoiHan = nhanThoiHan(daysRemaining);

  const toa = contract.room?.building?.name ?? null;
  const phong = contract.room?.name ?? null;
  const daiDien =
    (contract.contract_customers ?? []).find((cc) => cc.is_representative) ??
    (contract.contract_customers ?? [])[0];

  const dongPhu = [
    contract.contract_number,
    daiDien?.customer?.full_name,
    daiDien?.customer?.phone,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="sticky top-0 z-30 bg-[#11231b]">
      {/* Nền đen tràn hết bề ngang, nhưng NỘI DUNG bên trong nằm trong đúng
          container căn giữa của thân trang (KHUNG) — nếu không, ở màn rộng hoặc
          khi thu phóng, thân trang bị kẹp max-w rồi thụt vào giữa còn header thì
          bám sát mép, nhìn như hai trang khác nhau dán chồng. */}
      {/* Tầng 1 — danh tính + hành động */}
      <div className={`${KHUNG} flex flex-wrap items-center gap-x-5 gap-y-3 py-3`}>
        <div className="flex min-w-0 flex-[1_1_260px] items-center gap-2.5 overflow-hidden">
          <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-white/[.09]">
            <FileText className="h-[17px] w-[17px] text-[#4fbf87]" strokeWidth={2} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[17px] font-semibold tracking-[-0.01em] text-white">
                {[toa, phong ? `Phòng ${phong}` : null].filter(Boolean).join(' · ') ||
                  'Hợp đồng'}
              </span>
              <span
                className={
                  chip.xanh
                    ? 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#22c55e]/[.16] px-2.5 py-1 text-[12.5px] font-semibold tracking-[.02em] text-[#6ee7a8]'
                    : 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-white/[.12] px-2.5 py-1 text-[12.5px] font-semibold tracking-[.02em] text-[#cfd8d3]'
                }
              >
                <span
                  className={`h-[5px] w-[5px] rounded-full ${chip.xanh ? 'bg-[#34d399]' : 'bg-[#9ca3af]'}`}
                />
                {chip.nhan}
              </span>
              {/* Công nợ là chip RIÊNG, không đè chip trạng thái: một HĐ đang
                  chạy vẫn có thể còn nợ, giấu một trong hai là nói thiếu. */}
              {outstandingAmount > 0 && (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[#ef4444]/[.18] px-2.5 py-1 text-[12.5px] font-semibold tabular-nums tracking-[.02em] text-[#fca5a5]">
                  <span className="h-[5px] w-[5px] rounded-full bg-[#f87171]" />
                  Còn công nợ {formatAmount(outstandingAmount)}
                </span>
              )}
            </div>
            {dongPhu && (
              <div className="mt-1 truncate text-[13px] text-white/50">{dongPhu}</div>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-[0_1_auto] flex-wrap items-center justify-end gap-2">
          {contract.status !== 'TERMINATED' && canUse(perms, 'contracts', 'edit') && (
            <NutHeader icon={Pencil} nhan="Cập nhật" onClick={onEdit} />
          )}
          {canUse(perms, 'contracts', 'print') && (
            <NutHeader icon={Printer} nhan="In hợp đồng" onClick={onPrint} />
          )}
          {contract.status !== 'TERMINATED' && contract.status !== 'DRAFT' && (
            <NutHeader icon={QrCode} nhan="QR hợp đồng" onClick={onShowQR} />
          )}
          {isActive && (
            <>
              {canUse(perms, 'contracts', 'renew') && (
                <NutHeader icon={RefreshCw} nhan="Gia hạn" onClick={onRenew} />
              )}
              {canUse(perms, 'contracts', 'transfer') && (
                <NutHeader icon={ArrowRightLeft} nhan="Chuyển phòng" onClick={onTransferRoom} />
              )}
              {canUse(perms, 'contracts', 'transfer') && (
                <NutHeader icon={MoveRight} nhan="Nhượng HĐ" onClick={onTransferContract} />
              )}
              {canUse(perms, 'contracts', 'terminate') && (
                <NutHeader icon={Calendar} nhan="Đăng ký chuyển đi" onClick={onMoveOut} />
              )}
              {canUse(perms, 'contracts', 'terminate') && (
                <NutHeader icon={XCircle} nhan="Thanh lý" onClick={onTerminate} doTuoi />
              )}
            </>
          )}
          {contract.status === 'DRAFT' && canUse(perms, 'contracts', 'delete') && (
            <NutHeader icon={Trash2} nhan="Xoá" onClick={onDelete} doTuoi />
          )}

          <div className="mx-1 h-6 w-px bg-white/[.16]" />
          <button
            type="button"
            title="Đóng"
            onClick={onBack}
            className="inline-flex h-[34px] w-[34px] items-center justify-center rounded-md border border-white/[.16] text-[#cfd8d3] transition-colors hover:bg-white/[.14] hover:text-white"
          >
            <X className="h-[17px] w-[17px]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Tầng 2 — bốn chỉ số */}
      <div className="border-t border-white/[.09] bg-black/[.16]">
        <div className={`${KHUNG} flex flex-wrap items-stretch`}>
        <OChiSo
          nhan="Phòng · Toà nhà"
          className="min-w-0 flex-[0_1_200px] border-r border-white/[.08] py-3 pr-5"
        >
          <div className="mt-[3px] text-[17px] font-semibold text-white">
            {phong ?? '—'} <span className="font-normal text-white/45">—</span>{' '}
            {toa ?? '—'}
          </div>
        </OChiSo>

        <OChiSo
          nhan="Giá thuê"
          className="min-w-0 flex-[0_1_235px] border-r border-white/[.08] px-5 py-3"
        >
          <div className="mt-[3px] text-[17px] font-semibold tabular-nums text-[#6ee7a8]">
            {formatAmount(contract.rent_price ?? 0)}{' '}
            <span className="text-[13.5px] font-normal text-white/50">
              / {CHU_KY[contract.payment_cycle ?? ''] ?? 'kỳ'}
            </span>
          </div>
        </OChiSo>

        <OChiSo
          nhan="Hiệu lực"
          className="min-w-0 flex-[0_1_265px] border-r border-white/[.08] px-5 py-3"
        >
          <div className="mt-[3px] text-[17px] font-semibold tabular-nums text-white">
            {ngayVn(contract.start_date)}{' '}
            <span className="font-normal text-white/45">–</span>{' '}
            {ngayVn(contract.end_date)}
          </div>
        </OChiSo>

        <div className="min-w-0 flex-[1_1_320px] py-3 pl-5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[.07em] text-white/45">
              Thời hạn
            </span>
            <span className="whitespace-nowrap text-[13px] tabular-nums text-white/60">
              {tienDo}% · hết hạn {ngayVn(contract.end_date)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-3.5">
            <span className="whitespace-nowrap text-[17px] font-semibold tabular-nums text-white">
              {thoiHan.tienTo} {thoiHan.so}{' '}
              <span className="text-[13px] font-normal text-white/55">{thoiHan.donVi}</span>
            </span>
            <span className="whitespace-nowrap text-[13.5px] tabular-nums text-white/60">
              đã thuê {Math.max(daysElapsed, 0)} / {Math.max(totalDays, 0)} ngày
            </span>
          </div>
          <div className="mt-2.5 h-[6px] overflow-hidden rounded-full bg-white/[.14]">
            <div
              className={`h-full rounded-[3px] ${daysRemaining < 0 ? 'bg-[#f87171]' : 'bg-[#34d399]'}`}
              style={{ width: `${tienDo}%` }}
            />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
