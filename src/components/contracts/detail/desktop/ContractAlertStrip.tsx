// Dải cảnh báo mỏng ngay dưới header đen.
//
// Gom 5 cảnh báo mà bản cũ rải ở hai chỗ: 3 cái ở đầu ContractDetailView và 2
// cái chôn trong thẻ Tiền cọc của ContractSummary (phải bấm sang tab mới thấy).
//
// GIỮ NGUYÊN CÂU CHỮ VÀ LINK. Riêng hai cảnh báo về phiếu thanh lý chờ xử lý là
// chỗ DUY NHẤT trong app nhắc kế toán đi duyệt phiếu — mất nó là cọc không vào
// doanh thu và tiền hoàn không ra khỏi két mà không ai biết.

import { AlertCircle, Calendar, CheckCircle2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ContractWithRelations } from '@/hooks/useContracts';
import { formatAmount } from '@/components/contracts/detail/formatCurrency';

type Mau = 'do' | 'cam' | 'xanhDuong' | 'hoPhach';

const MAU: Record<Mau, string> = {
  do: 'border-red-200 bg-red-50 text-red-800',
  cam: 'border-orange-200 bg-orange-50 text-orange-900',
  xanhDuong: 'border-blue-200 bg-blue-50 text-blue-800',
  hoPhach: 'border-amber-300 bg-amber-50 text-amber-900',
};

function Dai({
  mau,
  icon: Icon,
  children,
}: {
  mau: Mau;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[length:var(--fs-sm)] leading-[1.5] ${MAU[mau]}`}
    >
      <Icon className="mt-[3px] h-4 w-4 shrink-0" strokeWidth={2} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const ngayVn = (gt: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(gt);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : gt;
};

interface Props {
  contract: ContractWithRelations;
  isActive: boolean;
  isExpiringSoon: boolean;
  daysRemaining: number;
  sideLoadErrors: string[];
  pendingForfeitCount: number;
  pendingRefundCount: number;
}

export function ContractAlertStrip({
  contract,
  isActive,
  isExpiringSoon,
  daysRemaining,
  sideLoadErrors,
  pendingForfeitCount,
  pendingRefundCount,
}: Props) {
  const cocThieu = (contract.deposit_remaining ?? 0) > 0;
  const choXuLy = pendingForfeitCount + pendingRefundCount;
  const coGi =
    sideLoadErrors.length > 0 ||
    (isExpiringSoon && isActive) ||
    (contract.expected_move_out_date && isActive) ||
    choXuLy > 0 ||
    cocThieu;

  if (!coGi) return null;

  const noCoc = contract as unknown as {
    deposit_debt_mode?: string | null;
    deposit_debt_reason?: string | null;
    deposit_topup_due_date?: string | null;
  };

  return (
    <div className="mb-4 flex flex-col gap-2.5">
      {sideLoadErrors.length > 0 && (
        <Dai mau="do" icon={AlertCircle}>
          Không tải được: {sideLoadErrors.join(', ')}. Số liệu các mục này có thể thiếu — tải
          lại trang hoặc kiểm tra kết nối.
        </Dai>
      )}

      {isExpiringSoon && isActive && (
        <Dai mau="cam" icon={AlertCircle}>
          Hợp đồng sẽ hết hạn trong {daysRemaining} ngày. Vui lòng liên hệ khách hàng để gia hạn.
        </Dai>
      )}

      {contract.expected_move_out_date && isActive && (
        <Dai mau="xanhDuong" icon={Calendar}>
          Khách đã đăng ký chuyển đi vào ngày {ngayVn(contract.expected_move_out_date)}.
        </Dai>
      )}

      {choXuLy > 0 && (
        <Dai mau="hoPhach" icon={AlertCircle}>
          <p className="font-medium">Phiếu thanh lý chờ xử lý ({choXuLy} phiếu)</p>
          {pendingForfeitCount > 0 && (
            <p className="text-[length:var(--fs-sm)]">
              Vào{' '}
              <a href="/income-expense" className="font-medium underline">
                Thu chi
              </a>{' '}
              bấm <b>Duyệt</b> phiếu "Doanh thu bỏ cọc" thì cọc mới vào doanh thu và hoá đơn
              thanh lý mới tất toán.
            </p>
          )}
          {pendingRefundCount > 0 && (
            <p className="text-[length:var(--fs-sm)]">
              Phiếu chi <b>"Trả khách thanh lý"</b> đang chờ: vào{' '}
              <a href="/income-expense" className="font-medium underline">
                Thu chi
              </a>{' '}
              → Sửa phiếu → <b>chọn sổ quỹ chi tiền</b> → Duyệt (chưa chọn sổ sẽ không duyệt
              được).
            </p>
          )}
        </Dai>
      )}

      {cocThieu &&
        (noCoc.deposit_debt_mode === 'FIRST_INVOICE' ? (
          <Dai mau="xanhDuong" icon={CheckCircle2}>
            <p className="font-medium">
              Còn {formatAmount(contract.deposit_remaining ?? 0)} cọc — thu trong hoá đơn đầu
            </p>
            <p className="text-[length:var(--fs-sm)]">
              Khách thanh toán đủ cọc trong hoá đơn cọc + tháng đầu (không nhắc bổ sung).
            </p>
          </Dai>
        ) : (
          <Dai mau="cam" icon={AlertCircle}>
            <p className="font-medium">
              Còn thiếu {formatAmount(contract.deposit_remaining ?? 0)} tiền cọc
            </p>
            {noCoc.deposit_debt_reason && (
              <p className="text-[length:var(--fs-sm)]">Lý do cho nợ: {noCoc.deposit_debt_reason}</p>
            )}
            {noCoc.deposit_topup_due_date && (
              <p className="text-[length:var(--fs-sm)]">
                Hẹn bổ sung: {ngayVn(noCoc.deposit_topup_due_date)}
              </p>
            )}
          </Dai>
        ))}
    </div>
  );
}
