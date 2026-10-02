import { ContractDetailRegion, type ContractDetailQueries } from './ContractDetailRegions';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Pencil } from 'lucide-react';
import '@/pages/contracts/contractDetailMobile.css';
import { canUse } from '@/lib/permissionPages';
import { type ContractWithRelations } from '@/types/contract';
import type { InvoiceWithRelations } from '@/types/invoice';
import type { ContractServiceItem, ContractHistoryItem, ContractDepositVoucher } from './types';
import { ContractMobileActions } from './ContractMobileActions';
import { ContractInfoTab } from './ContractInfoTab';
import { ContractInvoicesTab } from './ContractInvoicesTab';
import { ContractPaymentsTab } from './ContractPaymentsTab';
import { ContractHistoryTab } from './ContractHistoryTab';
import { ContractMobileSettlementStatus, type ContractMobileSettlementStatusProps } from './ContractMobileSettlementStatus';

interface Props extends Pick<ContractMobileSettlementStatusProps,
  'terminationInfo' | 'pendingForfeitCount' | 'pendingRefundCount' | 'statusLoading' | 'sideLoadErrors'> {
  contract: ContractWithRelations;
  /** false khi trang vừa thay khung chờ (ContractDetailLoadingFrame) — khỏi chạy lại hiệu ứng vào trang. */
  animateEntry?: boolean;
  queryStates?: ContractDetailQueries;
  services: ContractServiceItem[];
  invoices: InvoiceWithRelations[];
  history: ContractHistoryItem[];
  depositVouchers: ContractDepositVoucher[];
  perms: Parameters<typeof canUse>[0];
  customers: NonNullable<ContractWithRelations['contract_customers']>;
  commissionFollowup?: ReactNode;
  exitCasePanel?: ReactNode;
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

type TabId = 'info' | 'invoices' | 'payments' | 'history';
const TABS: { id: TabId; label: string }[] = [
  { id: 'info', label: 'Thông tin' },
  { id: 'invoices', label: 'Hoá đơn' },
  { id: 'payments', label: 'Thanh toán' },
  { id: 'history', label: 'Lịch sử' },
];

/** Trang chi tiết hợp đồng dạng app trên mobile — dựng theo design
 *  ContractDetailScreen (warm-neutral, scope .cdt-stage/.cdt-app). Full-screen
 *  ngoài MainLayout; nhận data + handler qua props (dialog do page render). */
export function ContractDetailMobile(props: Props) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>('info');
  const { contract, services, invoices, history, depositVouchers, perms, customers } = props;
  const canEdit = contract.status !== 'TERMINATED' && canUse(perms, 'contracts', 'edit');

  return (
    <div className="cdt-stage">
      <div className="cdt-app">
        <div className={props.animateEntry === false ? 'route' : 'route route-anim'}>
          <div className="mtop">
            <button className="mback" onClick={props.onBack} aria-label="Quay lại"><ArrowLeft /></button>
            <div className="mtitle">
              <h1>{contract.contract_number || contract.id.slice(0, 8)}</h1>
              <p>Chi tiết hợp đồng</p>
            </div>
            {canEdit && (
              <div className="mtop-act">
                <button className="mtop-btn ghost" onClick={props.onEdit}><Pencil size={15} />Sửa</button>
              </div>
            )}
          </div>

          <div className="mbody">
            {props.exitCasePanel}
            <ContractMobileSettlementStatus contract={contract} invoices={invoices} depositVouchers={depositVouchers}
              terminationInfo={props.terminationInfo} pendingForfeitCount={props.pendingForfeitCount}
              pendingRefundCount={props.pendingRefundCount} statusLoading={props.statusLoading} sideLoadErrors={props.sideLoadErrors} />
            <ContractMobileActions
              contract={contract}
              perms={perms}
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
            {props.commissionFollowup}

            <div className="cd-tabs">
              {TABS.map((t) => (
                <button key={t.id} className={'cd-tab' + (tab === t.id ? ' on' : '')} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </div>

            {/* Tab Thông tin: phần đọc từ hợp đồng (số HĐ, khách, phòng, cọc, thời hạn) hiện
                ngay; chỉ thẻ dịch vụ và danh sách phiếu cọc chờ nguồn riêng của chúng —
                khối xám ngay tại chỗ, lỗi đọc vẫn chặn đúng khu đó (chủ chốt 02/10/2026). */}
            {tab === 'info' && (
              <ContractInfoTab
                contract={contract}
                services={services}
                customers={customers}
                depositVouchers={depositVouchers}
                queryStates={props.queryStates}
                onOpenCustomer={(id) => navigate(`/customers/${id}`)}
              />
            )}
            {tab === 'invoices' && <ContractDetailRegion label="hóa đơn của hợp đồng" queries={[props.queryStates?.invoices]} skeleton="list" rows={4}><ContractInvoicesTab invoices={invoices} /></ContractDetailRegion>}
            {tab === 'payments' && <ContractDetailRegion label="thanh toán của hợp đồng" queries={[props.queryStates?.invoices]} skeleton="list" rows={4}><ContractPaymentsTab invoices={invoices} /></ContractDetailRegion>}
            {tab === 'history' && <ContractDetailRegion label="lịch sử hợp đồng" queries={[props.queryStates?.history]} skeleton="lines" rows={5}><ContractHistoryTab history={history} /></ContractDetailRegion>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ContractDetailMobile;
