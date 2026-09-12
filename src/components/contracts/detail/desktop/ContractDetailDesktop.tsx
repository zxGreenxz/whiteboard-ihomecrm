// Khung màn chi tiết hợp đồng — desktop bản mới (12/09/2026).
//
// Thay cho bố cục 5 tab: một trang hai cột, header đen dính đầu trang. Lý do đổi
// nằm ở spec docs/superpowers/specs/2026-09-12-chi-tiet-hop-dong-ban-moi-design.md
// — tóm tắt: câu hỏi thường gặp nhất ("khách này nợ gì, trả gì, HĐ đi tới đâu")
// trước phải bấm qua 3–4 tab rồi tự ghép số trong đầu.
//
// `--rp` là đệm dọc của mọi dòng trong trang. Bản thiết kế có núm 3 mức
// (Thoáng / Gọn / Rất gọn); chủ chốt mức "Gọn" và KHÔNG làm thành tuỳ chọn cho
// người dùng, nên nó là một hằng ở đúng một chỗ này.

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
import { ContractTopBar } from './ContractTopBar';
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
      style={{ ['--rp' as string]: '7px' }}
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

      <div className="mx-auto max-w-[1720px] px-[18px] pb-10 pt-3.5">
        <ContractAlertStrip
          contract={contract}
          isActive={isActive}
          isExpiringSoon={isExpiringSoon}
          daysRemaining={daysRemaining}
          sideLoadErrors={sideLoadErrors}
          pendingForfeitCount={pendingForfeitCount}
          pendingRefundCount={pendingRefundCount}
        />

        <div className="grid items-start gap-3.5 [grid-template-columns:minmax(0,1fr)] xl:[grid-template-columns:minmax(0,1fr)_minmax(0,1.12fr)]">
          <div className="flex min-w-0 flex-col gap-3.5">
            <ContractTermsCard
              contract={contract}
              services={services}
              servicesLoading={servicesLoading}
              history={history}
              historyLoading={historyLoading}
            />
            <ContractTenantsCard
              contract={contract}
              customers={customers}
              vehiclesByCustomer={vehiclesByCustomer}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-3.5">
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
