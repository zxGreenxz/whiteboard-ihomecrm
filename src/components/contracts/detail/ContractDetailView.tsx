import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Calendar, AlertCircle } from 'lucide-react';
import { useContract } from '@/hooks/useContracts';
import { isContractInEffect } from '@/types/contract';
import { useInvoicesLegacy } from '@/hooks/useInvoices';
import { format, differenceInDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useState } from 'react';
// Data layer tách riêng (Phase 9B) — UI không gọi supabase trực tiếp nữa.
import {
  useContractDepositVouchers,
  useContractPendingTermination,
  useContractTerminationInfo,
  useContractVehicles,
  useContractServices,
  useContractHistory,
} from '@/hooks/contracts/useContractDetailData';

// Import contract action dialogs
import { RenewDialog } from '@/components/contracts/RenewDialog';
import { TransferContractDialog } from '@/components/contracts/TransferContractDialog';
import { TransferRoomDialog } from '@/components/contracts/TransferRoomDialog';
import { TerminateDialog } from '@/components/contracts/TerminateDialog';
import RegisterMoveOutDialog from '@/components/contracts/RegisterMoveOutDialog';
import ContractQRDialog from '@/components/contracts/ContractQRDialog';
import { ContractFormDialog } from '@/components/contracts/ContractFormDialog';
import { PrintContractDialog } from '@/components/contracts/PrintContractDialog';
import { DeleteContractDialog } from '@/components/contracts/DeleteContractDialog';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { usePhoneViewport } from '@/hooks/use-mobile';
import { ContractDetailMobile } from '@/components/contracts/detail/ContractDetailMobile';
// Types dùng chung với nhánh mobile (trước đây khai cục bộ ở đây).
import type { ContractServiceItem as ContractService, ContractHistoryItem } from '@/components/contracts/detail/types';
// UI desktop tách theo tab (Phase 10D) — JSX di chuyển nguyên văn, state/handler
// vẫn ở root này, nối xuống qua props.
import { ContractActionBar } from './ContractActionBar';
import { ContractGeneralTab } from './ContractGeneralTab';
import { ContractServicesTab } from './ContractServicesTab';
import { ContractInvoicesTabDesktop } from './ContractInvoicesTabDesktop';
import { ContractPaymentsTabDesktop } from './ContractPaymentsTabDesktop';
import { ContractHistoryTabDesktop } from './ContractHistoryTabDesktop';

interface ContractDetailViewProps {
  /** ID hợp đồng cần hiển thị (đã đảm bảo có giá trị bởi nơi gọi). */
  id: string;
  /** Quay lại danh sách / đóng modal. */
  onBack: () => void;
  /** Ẩn nút "Quay lại" ở đầu (modal đã có nút X riêng). */
  showBackButton?: boolean;
}

/**
 * Nội dung chi tiết hợp đồng — KHÔNG kèm khung (MainLayout / Dialog).
 * Dùng chung cho route /contracts/:id (deep-link) và modal full-screen mở từ
 * danh sách (giữ nguyên bộ lọc đang dò).
 */
const ContractDetailView = ({ id, onBack, showBackButton = true }: ContractDetailViewProps) => {
  const { data: perms } = useMyPermissions();
  // Khởi tạo ĐỒNG BỘ (matchMedia) để render thẳng bản mobile ở frame đầu — không
  // nháy 1 frame bản desktop rồi mới đổi (useIsMobile bị undefined→false).
  const isMobile = usePhoneViewport();

  // Dialog states
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [transferRoomDialogOpen, setTransferRoomDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [moveOutDialogOpen, setMoveOutDialogOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Fetch contract with relations
  const { data: contract, isLoading: contractLoading } = useContract(id || '');

  // Fetch invoices for this contract
  const { data: invoices, isLoading: invoicesLoading } = useInvoicesLegacy({
    contract_id: id
  });

  // Phiếu thu cọc (IE) đã link contract này — chứng minh deposit_paid khớp phiếu.
  const depositVouchersQ = useContractDepositVouchers(id);
  const depositVouchers = depositVouchersQ.data ?? [];

  // Phiếu thanh lý đang CHỜ XỬ LÝ (forfeit chờ duyệt / refund nháp chưa có sổ).
  const pendingTerminationQ = useContractPendingTermination(id);
  const pendingForfeitCount = pendingTerminationQ.data?.forfeit ?? 0;
  const pendingRefundCount = pendingTerminationQ.data?.refund ?? 0;

  // Quyết toán thanh lý (audit contract_terminations).
  const terminationInfoQ = useContractTerminationInfo(id, contract?.status);
  const terminationInfo = terminationInfoQ.data;

  // Customers attached to this contract — read from contract.contract_customers
  // (đại diện đứng đầu, sau đó tới các khách còn lại)
  const contractCustomers = (contract?.contract_customers ?? [])
    .slice()
    .sort((a, b) => Number(b.is_representative) - Number(a.is_representative));

  // Phương tiện gắn với các khách trong hợp đồng (gom theo customer_id)
  const customerIds = contractCustomers.map((cc) => cc.customer_id);
  const contractVehiclesQ = useContractVehicles(id, customerIds);
  const contractVehicles = contractVehiclesQ.data ?? [];

  const vehiclesByCustomer = new Map<string, typeof contractVehicles>();
  for (const v of contractVehicles) {
    const arr = vehiclesByCustomer.get(v.customer_id) ?? [];
    arr.push(v);
    vehiclesByCustomer.set(v.customer_id, arr);
  }

  // Dịch vụ + lịch sử HĐ — trước là useEffect + state thủ công nuốt lỗi thành
  // rỗng; nay là useQuery, lỗi hiển thị ra UI thay vì im lặng.
  const servicesQ = useContractServices(id);
  const contractServices: ContractService[] = servicesQ.data ?? [];
  const servicesLoading = servicesQ.isLoading;
  const historyQ = useContractHistory(id);
  const contractHistory: ContractHistoryItem[] = historyQ.data ?? [];
  const historyLoading = historyQ.isLoading;

  // Gom lỗi các query phụ để báo 1 chỗ (data chính contract lỗi đã có nhánh riêng).
  const sideLoadErrors = [
    depositVouchersQ.isError && 'phiếu cọc',
    pendingTerminationQ.isError && 'phiếu thanh lý chờ xử lý',
    terminationInfoQ.isError && 'quyết toán thanh lý',
    contractVehiclesQ.isError && 'phương tiện',
    servicesQ.isError && 'dịch vụ',
    historyQ.isError && 'lịch sử hợp đồng',
  ].filter(Boolean) as string[];

  // Error states
  if (!id) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">ID hợp đồng không hợp lệ</p>
        <Button onClick={onBack} className="mt-4">
          Quay lại danh sách
        </Button>
      </div>
    );
  }

  if (contractLoading) {
    return (
      <div className="text-center py-12 text-gray-500">
        Đang tải thông tin hợp đồng...
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Không tìm thấy hợp đồng với ID này</p>
        <Button onClick={onBack} className="mt-4">
          Quay lại danh sách
        </Button>
      </div>
    );
  }

  // Calculate contract metrics
  const today = new Date();
  const endDate = new Date(contract.end_date);
  const startDate = new Date(contract.start_date);
  const daysRemaining = differenceInDays(endDate, today);
  const totalDays = differenceInDays(endDate, startDate);
  const daysElapsed = differenceInDays(today, startDate);
  const progressPercent = Math.min(Math.max((daysElapsed / totalDays) * 100, 0), 100);

  const isExpiringSoon = daysRemaining > 0 && daysRemaining <= 30;
  const isExpired = daysRemaining < 0;
  const isActive = isContractInEffect(contract.status);

  // Calculate total paid and outstanding from invoices
  const totalInvoiced = invoices?.reduce((sum, inv) => sum + (inv.total_amount || 0), 0) || 0;
  const totalPaid = invoices?.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0) || 0;
  const outstandingAmount = totalInvoiced - totalPaid;

  // Dialog hành động — render chung cho cả mobile & desktop (state ở trên).
  const dialogs = (
    <>
      <RenewDialog open={extendDialogOpen} onOpenChange={setExtendDialogOpen} contract={contract} />
      <TransferContractDialog open={transferDialogOpen} onOpenChange={setTransferDialogOpen} contract={contract} />
      <TerminateDialog open={terminateDialogOpen} onOpenChange={setTerminateDialogOpen} contract={contract} />
      <RegisterMoveOutDialog open={moveOutDialogOpen} onOpenChange={setMoveOutDialogOpen} contract={contract} />
      <ContractQRDialog
        open={qrDialogOpen}
        onOpenChange={setQrDialogOpen}
        publicCode={contract.public_code}
        contractLabel={contract.contract_number || contract.id.slice(0, 8)}
        buildingName={contract.room?.building?.name}
        roomName={contract.room?.name}
      />
      <ContractFormDialog open={editDialogOpen} onOpenChange={setEditDialogOpen} contract={contract} />
      <PrintContractDialog open={printDialogOpen} onOpenChange={setPrintDialogOpen} contract={contract} />
      <TransferRoomDialog open={transferRoomDialogOpen} onOpenChange={setTransferRoomDialogOpen} contract={contract} />
      <DeleteContractDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen} contract={contract} />
    </>
  );

  // Mobile: trang chi tiết full-screen (scope CSS riêng, NGOÀI MainLayout) — giống
  // design. Import TĨNH (không lazy/Suspense) để không nháy frame trống khi mở;
  // CSS .cdt-* scope riêng nên không ảnh hưởng desktop.
  if (isMobile) {
    return (
      <>
        <ContractDetailMobile
          contract={contract}
          services={contractServices}
          invoices={invoices ?? []}
          history={contractHistory}
          depositVouchers={depositVouchers}
          perms={perms}
          customers={contractCustomers}
          onBack={onBack}
          onEdit={() => setEditDialogOpen(true)}
          onPrint={() => setPrintDialogOpen(true)}
          onShowQR={() => setQrDialogOpen(true)}
          onRenew={() => setExtendDialogOpen(true)}
          onTransferRoom={() => setTransferRoomDialogOpen(true)}
          onTransferContract={() => setTransferDialogOpen(true)}
          onMoveOut={() => setMoveOutDialogOpen(true)}
          onTerminate={() => setTerminateDialogOpen(true)}
          onDelete={() => setDeleteDialogOpen(true)}
        />
        {dialogs}
      </>
    );
  }

  return (
    <>
      {/* Header Actions */}
      <ContractActionBar
        contract={contract}
        perms={perms}
        isActive={isActive}
        showBackButton={showBackButton}
        onBack={onBack}
        onEdit={() => setEditDialogOpen(true)}
        onPrint={() => setPrintDialogOpen(true)}
        onShowQR={() => setQrDialogOpen(true)}
        onRenew={() => setExtendDialogOpen(true)}
        onTransferRoom={() => setTransferRoomDialogOpen(true)}
        onTransferContract={() => setTransferDialogOpen(true)}
        onMoveOut={() => setMoveOutDialogOpen(true)}
        onTerminate={() => setTerminateDialogOpen(true)}
        onDelete={() => setDeleteDialogOpen(true)}
      />

      {/* Alerts */}
      {sideLoadErrors.length > 0 && (
        <Alert className="mb-6 bg-red-50 border-red-200">
          <AlertCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-800">
            Không tải được: {sideLoadErrors.join(', ')}. Số liệu các mục này có thể
            thiếu — tải lại trang hoặc kiểm tra kết nối.
          </AlertDescription>
        </Alert>
      )}

      {isExpiringSoon && isActive && (
        <Alert className="mb-6 bg-orange-50 border-orange-200">
          <AlertCircle className="h-4 w-4 text-orange-600" />
          <AlertDescription className="text-orange-800">
            Hợp đồng sẽ hết hạn trong {daysRemaining} ngày. Vui lòng liên hệ khách hàng để gia hạn.
          </AlertDescription>
        </Alert>
      )}

      {contract.expected_move_out_date && isActive && (
        <Alert className="mb-6 bg-blue-50 border-blue-200">
          <Calendar className="h-4 w-4 text-blue-600" />
          <AlertDescription className="text-blue-800">
            Khách đã đăng ký chuyển đi vào ngày {format(new Date(contract.expected_move_out_date), 'dd/MM/yyyy', { locale: vi })}.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="general" className="space-y-6">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="general">Thông tin chung</TabsTrigger>
          <TabsTrigger value="services">Dịch vụ</TabsTrigger>
          <TabsTrigger value="invoices">Hóa đơn</TabsTrigger>
          <TabsTrigger value="payments">Thanh toán</TabsTrigger>
          <TabsTrigger value="history">Lịch sử</TabsTrigger>
        </TabsList>

        {/* Tab 1: General Information */}
        <TabsContent value="general" className="space-y-6">
          <ContractGeneralTab
            contract={contract}
            contractCustomers={contractCustomers}
            vehiclesByCustomer={vehiclesByCustomer}
            isExpiringSoon={isExpiringSoon}
            isExpired={isExpired}
            daysRemaining={daysRemaining}
            progressPercent={progressPercent}
            terminationInfo={terminationInfo}
            pendingForfeitCount={pendingForfeitCount}
            pendingRefundCount={pendingRefundCount}
            depositVouchers={depositVouchers}
            invoices={invoices}
            totalInvoiced={totalInvoiced}
            totalPaid={totalPaid}
            outstandingAmount={outstandingAmount}
            totalDays={totalDays}
            daysElapsed={daysElapsed}
          />
        </TabsContent>

        {/* Tab 2: Services */}
        <TabsContent value="services">
          <ContractServicesTab services={contractServices} loading={servicesLoading} />
        </TabsContent>

        {/* Tab 3: Invoices */}
        <TabsContent value="invoices">
          <ContractInvoicesTabDesktop invoices={invoices} loading={invoicesLoading} />
        </TabsContent>

        {/* Tab 4: Payments */}
        <TabsContent value="payments">
          <ContractPaymentsTabDesktop invoices={invoices} loading={invoicesLoading} />
        </TabsContent>

        {/* Tab 5: History */}
        <TabsContent value="history">
          <ContractHistoryTabDesktop history={contractHistory} loading={historyLoading} />
        </TabsContent>
      </Tabs>
      {dialogs}
    </>
  );
};

export default ContractDetailView;
