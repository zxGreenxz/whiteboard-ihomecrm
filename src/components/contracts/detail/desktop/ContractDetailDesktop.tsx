// Khung màn chi tiết hợp đồng — desktop bản mới (12/09/2026).
//
// Thay cho bố cục 5 tab: một trang hai cột, header đen dính đầu trang. Lý do đổi
// nằm ở spec docs/superpowers/specs/2026-09-12-chi-tiet-hop-dong-ban-moi-design.md
// — tóm tắt: câu hỏi thường gặp nhất ("khách này nợ gì, trả gì, HĐ đi tới đâu")
// trước phải bấm qua 3–4 tab rồi tự ghép số trong đầu.
//
// THANG KÍCH THƯỚC NẰM Ở ĐÚNG MỘT CHỖ — 5 biến CSS dưới đây.
//
// Mọi component con đọc biến, không gõ px cứng. Muốn thoáng hơn / chữ to hơn thì
// sửa đúng khối `style` trong file này; không phải lùng 6 file và cũng không sợ
// sót một chỗ rồi lệch nhịp.
//
// Mức hiện tại (13/09): chủ yêu cầu "giãn ra, chữ to lên" so với đợt đầu —
//   --rp   7px  → 10px
//   --px   14px → 18px
//   --fs   13px → 14.5px
// Bản thiết kế gốc có núm 3 mức (Thoáng / Gọn / Rất gọn) nhưng đây KHÔNG làm
// thành tuỳ chọn cho người dùng, chỉ là hằng của màn hình.

import type { ContractWithRelations } from '@/hooks/useContracts';
import type { InvoiceWithRelations } from '@/hooks/useInvoices';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';
import type {
  ContractServiceItem,
  ContractHistoryItem,
  ContractVehicle,
  ContractDepositVoucher,
} from '@/components/contracts/detail/types';
import { canUse } from '@/lib/permissionPages';
import type { DichVuToaLite } from './effectiveServices';
import { ContractTopBar, KHUNG } from './ContractTopBar';
import { ContractAlertStrip } from './ContractAlertStrip';
import { ContractTermsCard } from './ContractTermsCard';
import { ContractTenantsCard } from './ContractTenantsCard';
import { ContractFinanceCard } from './ContractFinanceCard';

export interface ContractDetailDesktopProps {
  contract: ContractWithRelations;
  perms: Parameters<typeof canUse>[0];
  isActive: boolean;
  isExpiringSoon: boolean;
  daysRemaining: number;
  totalDays: number;
  daysElapsed: number;
  outstandingAmount: number;
  sideLoadErrors: string[];
  customers: NonNullable<ContractWithRelations['contract_customers']>;
  vehiclesByCustomer: Map<string, ContractVehicle[]>;
  services: ContractServiceItem[];
  servicesLoading: boolean;
  buildingServices: DichVuToaLite[];
  buildingServicesLoading: boolean;
  history: ContractHistoryItem[];
  historyLoading: boolean;
  invoices: InvoiceWithRelations[] | undefined;
  invoicesLoading: boolean;
  depositVouchers: ContractDepositVoucher[];
  terminationInfo: ContractTerminationInfo | null | undefined;
  pendingForfeitCount: number;
  pendingRefundCount: number;
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

export function ContractDetailDesktop(props: ContractDetailDesktopProps) {
  const {
    contract,
    perms,
    isActive,
    isExpiringSoon,
    daysRemaining,
    totalDays,
    daysElapsed,
    outstandingAmount,
    sideLoadErrors,
    customers,
    vehiclesByCustomer,
    services,
    servicesLoading,
    buildingServices,
    buildingServicesLoading,
    history,
    historyLoading,
    invoices,
    invoicesLoading,
    depositVouchers,
    terminationInfo,
    pendingForfeitCount,
    pendingRefundCount,
    onBack,
  } = props;

  return (
    <div
      className="min-h-full bg-[#f4f6f8] text-[#121f17]"
      style={
        {
          '--rp': '10px', // đệm DỌC mỗi dòng
          '--px': '18px', // đệm NGANG trong thẻ
          '--fs': '14.5px', // chữ chính của một dòng
          '--fs-sm': '13.5px', // chữ phụ: kỳ, ghi chú, meta khách
          '--fs-xs': '11.5px', // nhãn UPPERCASE nhỏ
        } as React.CSSProperties
      }
    >
      <ContractTopBar
        contract={contract}
        perms={perms}
        isActive={isActive}
        outstandingAmount={outstandingAmount}
        daysRemaining={daysRemaining}
        totalDays={totalDays}
        daysElapsed={daysElapsed}
        onBack={onBack}
        onEdit={props.onEdit}
        onPrint={props.onPrint}
        onShowQR={props.onShowQR}
        onRenew={props.onRenew}
        onTransferRoom={props.onTransferRoom}
        onTransferContract={props.onTransferContract}
        onMoveOut={props.onMoveOut}
        onTerminate={props.onTerminate}
        onDelete={props.onDelete}
      />

      <div className={`${KHUNG} pb-12 pt-4`}>
        <ContractAlertStrip
          contract={contract}
          isActive={isActive}
          isExpiringSoon={isExpiringSoon}
          daysRemaining={daysRemaining}
          sideLoadErrors={sideLoadErrors}
          pendingForfeitCount={pendingForfeitCount}
          pendingRefundCount={pendingRefundCount}
        />

        {/* HAI CỘT HAY MỘT CỘT LÀ DO KHUNG CHỨA QUYẾT ĐỊNH, KHÔNG PHẢI VIEWPORT.
            Trước đây dùng breakpoint `xl:` (1280px viewport) nên không hề biết
            sidebar đang chiếm 264px: ở viewport 1280 vùng dùng được chỉ còn
            1208px, chia đôi ra cột phải 611px trong khi bảng Tài chính cần
            700px — thẻ nào cũng phải cuộn ngang. `auto-fit` + `minmax(700px,1fr)`
            tự đo khung thật: chưa đủ chỗ cho hai cột 700px thì xếp dọc, mỗi thẻ
            rộng hết khung; đủ chỗ thì thành hai cột. Đúng ở cả modal (không
            sidebar) lẫn route (có sidebar) mà không cần khai ngưỡng nào. */}
        <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(700px,1fr))]">
          <div className="flex min-w-0 flex-col gap-4">
            <ContractTermsCard
              contract={contract}
              services={services}
              servicesLoading={servicesLoading}
              buildingServices={buildingServices}
              buildingServicesLoading={buildingServicesLoading}
              history={history}
              historyLoading={historyLoading}
            />
            <ContractTenantsCard
              contract={contract}
              customers={customers}
              vehiclesByCustomer={vehiclesByCustomer}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <ContractFinanceCard
              contract={contract}
              depositVouchers={depositVouchers}
              invoices={invoices}
              invoicesLoading={invoicesLoading}
              terminationInfo={terminationInfo}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
