import { useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { canUse } from '@/lib/permissionPages';
import type { ContractWithRelations } from '@/types/contract';
import type { InvoiceWithRelations } from '@/types/invoice';
import type { ContractServiceItem, ContractHistoryItem, ContractVehicle } from './types';
import { ContractMobileHeader } from './ContractMobileHeader';
import { ContractMobileActions } from './ContractMobileActions';
import { ContractInfoTab } from './ContractInfoTab';
import { ContractInvoicesTab } from './ContractInvoicesTab';
import { ContractPaymentsTab } from './ContractPaymentsTab';
import { ContractHistoryTab } from './ContractHistoryTab';

interface Props {
  contract: ContractWithRelations;
  services: ContractServiceItem[];
  invoices: InvoiceWithRelations[];
  history: ContractHistoryItem[];
  perms: Parameters<typeof canUse>[0];
  customers: NonNullable<ContractWithRelations['contract_customers']>;
  vehiclesByCustomer: Map<string, ContractVehicle[]>;
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

/** Lớp trình bày MOBILE của trang chi tiết hợp đồng. Nhận data + handler qua
 *  props từ ContractDetailPage (không truy vấn lại); dialog hành động vẫn do
 *  page render (dùng chung desktop). Đúng 4 tab: Thông tin · Hoá đơn · Thanh
 *  toán · Lịch sử (bỏ tab "Dịch vụ" — gộp vào Thông tin). */
export function ContractDetailMobile(props: Props) {
  const navigate = useNavigate();
  const { contract, services, invoices, history, perms, customers, vehiclesByCustomer } = props;
  return (
    <div className="pb-6">
      <ContractMobileHeader contract={contract} onBack={() => navigate(-1)} />
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
      <Tabs defaultValue="info">
        <TabsList className="w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <TabsTrigger value="info">Thông tin</TabsTrigger>
          <TabsTrigger value="invoices">Hoá đơn</TabsTrigger>
          <TabsTrigger value="payments">Thanh toán</TabsTrigger>
          <TabsTrigger value="history">Lịch sử</TabsTrigger>
        </TabsList>
        <TabsContent value="info" className="mt-4">
          <ContractInfoTab contract={contract} services={services} customers={customers} vehiclesByCustomer={vehiclesByCustomer} />
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <ContractInvoicesTab invoices={invoices} />
        </TabsContent>
        <TabsContent value="payments" className="mt-4">
          <ContractPaymentsTab invoices={invoices} />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ContractHistoryTab history={history} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
