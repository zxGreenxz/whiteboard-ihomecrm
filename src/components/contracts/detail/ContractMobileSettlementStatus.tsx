import type { ContractWithRelations } from '@/types/contract';
import type { InvoiceWithRelations } from '@/types/invoice';
import type { ContractTerminationInfo } from '@/hooks/contracts/useContractDetailData';
import type { ContractDepositVoucher } from './types';
import { formatCurrency } from './formatCurrency';
import { dungBangTaiChinh } from './desktop/contractFinanceRows';
import { LoadingState } from '@/components/loading/LoadingState';

export interface ContractMobileSettlementStatusProps {
  contract: ContractWithRelations;
  invoices: InvoiceWithRelations[];
  depositVouchers: ContractDepositVoucher[];
  terminationInfo: ContractTerminationInfo | null | undefined;
  pendingForfeitCount: number;
  pendingRefundCount: number;
  statusLoading: boolean;
  sideLoadErrors: string[];
}

/** Status only: use the same totals as desktop and preserve each money direction. */
export function ContractMobileSettlementStatus(props: ContractMobileSettlementStatusProps) {
  if (props.contract.status !== 'TERMINATED') return null;
  const { tong } = dungBangTaiChinh({
    contract: props.contract,
    invoices: props.invoices,
    depositVouchers: props.depositVouchers,
    terminationInfo: props.terminationInfo,
  });
  const loaded = !props.statusLoading && props.sideLoadErrors.length === 0;
  const settled = loaded && !!props.terminationInfo && props.pendingRefundCount === 0
    && props.pendingForfeitCount === 0 && tong.noHoaDon === 0 && tong.thieuCoc === 0 && tong.chuaHoanKhach === 0;

  return <section aria-label="Trạng thái sau trả phòng" className="mb-4 rounded-lg border bg-white p-3 text-sm">
    <h2 className="font-semibold">Trạng thái sau trả phòng</h2>
    <p className="mt-1 text-muted-foreground">Khách đã trả phòng</p>
    {props.sideLoadErrors.length > 0 ? <p role="alert" className="mt-2 text-destructive">
      Không tải được: {props.sideLoadErrors.join(', ')}. Chưa thể xác nhận trạng thái thanh lý.
    </p> : props.statusLoading ? <LoadingState label="trạng thái thanh lý" rows={2} className="mt-1" />
      : <div className="mt-2 space-y-1">
      {!props.terminationInfo && <p className="text-amber-800">Chưa chốt quyết toán</p>}
      {tong.noHoaDon > 0 && <p className="font-medium text-red-700">Nợ hoá đơn {formatCurrency(tong.noHoaDon)}</p>}
      {tong.thieuCoc > 0 && <p className="font-medium text-orange-700">Thiếu cọc {formatCurrency(tong.thieuCoc)}</p>}
      {tong.chuaHoanKhach > 0 && <p className="font-medium text-rose-800">Chưa hoàn khách {formatCurrency(tong.chuaHoanKhach)}</p>}
      {settled && <p className="font-medium text-green-700">Không còn khoản nào treo</p>}
    </div>}
    {props.pendingRefundCount > 0 && <p className="mt-2 text-amber-800">Phiếu hoàn chờ xử lý ({props.pendingRefundCount})</p>}
    {props.pendingForfeitCount > 0 && <p className="mt-2 text-amber-800">Phiếu bỏ cọc chờ xử lý ({props.pendingForfeitCount})</p>}
  </section>;
}
