import { useParams, useNavigate } from 'react-router-dom';
import MainLayout from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  FileText,
  ArrowLeft,
  Calendar,
  User,
  Home,
  DollarSign,
  Clock,
  RefreshCw,
  MoveRight,
  XCircle,
  Printer,
  AlertCircle,
  CheckCircle,
  Building2,
  Phone,
  Mail,
  CreditCard,
  Zap,
  Droplets,
  Receipt,
  History,
  Settings,
  ExternalLink,
} from 'lucide-react';
import { useContract, ContractWithRelations } from '@/hooks/useContracts';
import { useInvoicesLegacy } from '@/hooks/useInvoices';
import { format, differenceInDays } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

// Import contract action dialogs
import ExtendContractDialog from '@/components/contracts/ExtendContractDialog';
import TransferContractDialog from '@/components/contracts/TransferContractDialog';
import TerminateContractDialog from '@/components/contracts/TerminateContractDialog';
import RegisterMoveOutDialog from '@/components/contracts/RegisterMoveOutDialog';

// Types for contract services and history
interface ContractService {
  id: string;
  service_id: string;
  unit_price: number;
  initial_reading: number | null;
  service: {
    id: string;
    name: string;
    type: string;
    unit: string;
  };
}

interface ContractHistoryItem {
  id: string;
  type: 'extension' | 'transfer' | 'termination';
  created_at: string;
  status: string;
  details: Record<string, any>;
}

const ContractDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Dialog states
  const [extendDialogOpen, setExtendDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [terminateDialogOpen, setTerminateDialogOpen] = useState(false);
  const [moveOutDialogOpen, setMoveOutDialogOpen] = useState(false);

  // Fetch contract with relations
  const { data: contract, isLoading: contractLoading } = useContract(id || '');

  // Fetch invoices for this contract
  const { data: invoices, isLoading: invoicesLoading } = useInvoicesLegacy({
    contract_id: id
  });

  // Fetch contract services
  const [contractServices, setContractServices] = useState<ContractService[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);

  // Fetch contract tenants directly (separate query to avoid join issues)
  const [contractTenants, setContractTenants] = useState<Array<{
    id: string;
    tenant_id: string;
    is_representative: boolean;
    move_in_date: string | null;
    tenant: { id: string; full_name: string; phone: string; email: string | null } | null;
  }>>([]);

  // Fetch contract history (extensions, transfers, terminations)
  const [contractHistory, setContractHistory] = useState<ContractHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Fetch contract tenants when contract ID changes
  useEffect(() => {
    const fetchContractTenants = async () => {
      if (!id) return;
      try {
        const { data, error } = await (supabase as any)
          .from('contract_tenants')
          .select(`
            id, tenant_id, is_representative, move_in_date,
            tenant:tenants(id, full_name, phone, email)
          `)
          .eq('contract_id', id)
          .order('is_representative', { ascending: false });

        if (!error && data) {
          setContractTenants(data);
        }
      } catch (e) {
        console.error('Error fetching contract tenants:', e);
      }
    };

    fetchContractTenants();
  }, [id]);

  // Fetch contract services when contract ID changes
  useEffect(() => {
    const fetchContractServices = async () => {
      if (!id) return;
      setServicesLoading(true);
      try {
        const { data, error } = await supabase
          .from('contract_services')
          .select(`
            id, service_id, unit_price, initial_reading,
            service:services(id, name, type, unit)
          `)
          .eq('contract_id', id);

        if (!error && data) {
          setContractServices(data as ContractService[]);
        }
      } catch (e) {
        console.error('Error fetching contract services:', e);
      } finally {
        setServicesLoading(false);
      }
    };

    fetchContractServices();
  }, [id]);

  // Fetch contract history when contract ID changes
  useEffect(() => {
    const fetchContractHistory = async () => {
      if (!id) return;
      setHistoryLoading(true);
      try {
        const history: ContractHistoryItem[] = [];

        // Fetch extensions
        const { data: extensions } = await supabase
          .from('contract_extensions')
          .select('*')
          .eq('contract_id', id)
          .order('created_at', { ascending: false });

        if (extensions) {
          extensions.forEach(ext => {
            history.push({
              id: ext.id,
              type: 'extension',
              created_at: ext.created_at,
              status: ext.status,
              details: ext
            });
          });
        }

        // Fetch transfers
        const { data: transfers } = await supabase
          .from('contract_transfers')
          .select('*')
          .eq('contract_id', id)
          .order('created_at', { ascending: false });

        if (transfers) {
          transfers.forEach(tr => {
            history.push({
              id: tr.id,
              type: 'transfer',
              created_at: tr.created_at,
              status: tr.status,
              details: tr
            });
          });
        }

        // Fetch terminations
        const { data: terminations } = await supabase
          .from('contract_terminations')
          .select('*')
          .eq('contract_id', id)
          .order('created_at', { ascending: false });

        if (terminations) {
          terminations.forEach(term => {
            history.push({
              id: term.id,
              type: 'termination',
              created_at: term.created_at,
              status: term.status,
              details: term
            });
          });
        }

        // Sort by date
        history.sort((a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );

        setContractHistory(history);
      } catch (e) {
        console.error('Error fetching contract history:', e);
      } finally {
        setHistoryLoading(false);
      }
    };

    fetchContractHistory();
  }, [id]);

  // Helper functions
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('vi-VN', {
      style: 'currency',
      currency: 'VND',
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string; className?: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      ACTIVE: { variant: 'default', label: 'Đang hoạt động', className: 'bg-green-500 hover:bg-green-600' },
      EXTENDED: { variant: 'secondary', label: 'Đã gia hạn', className: 'bg-blue-500 hover:bg-blue-600 text-white' },
      TRANSFERRED: { variant: 'secondary', label: 'Đã chuyển nhượng', className: 'bg-purple-500 hover:bg-purple-600 text-white' },
      TERMINATED: { variant: 'destructive', label: 'Đã thanh lý' },
      EXPIRED: { variant: 'outline', label: 'Hết hạn' },
    };

    const config = variants[status] || { variant: 'outline' as const, label: status };
    return (
      <Badge variant={config.variant} className={config.className}>
        {config.label}
      </Badge>
    );
  };

  const getPaymentCycleLabel = (cycle: string) => {
    const labels: Record<string, string> = {
      MONTHLY: 'Hàng tháng',
      QUARTERLY: 'Hàng quý',
      SEMI_ANNUAL: '6 tháng',
      ANNUAL: 'Hàng năm',
    };
    return labels[cycle] || cycle;
  };

  const getLocationDisplay = (contract: ContractWithRelations) => {
    if (contract.bed) {
      return `${contract.bed.name} - ${contract.bed.room.name} - ${contract.bed.room.building.name}`;
    }
    if (contract.room) {
      return `${contract.room.name} - ${contract.room.building.name}`;
    }
    return 'N/A';
  };

  const getServiceTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      FIXED: 'Cố định',
      PER_PERSON: 'Theo người',
      PER_ROOM: 'Theo phòng',
      METER_READING: 'Theo công tơ',
    };
    return labels[type] || type;
  };

  const getServiceTypeIcon = (type: string) => {
    if (type === 'METER_READING') {
      return <Zap className="h-4 w-4 text-yellow-500" />;
    }
    return <Settings className="h-4 w-4 text-gray-500" />;
  };

  const getInvoiceStatusBadge = (status: string) => {
    const variants: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
      DRAFT: { variant: 'outline', label: 'Nháp' },
      APPROVED: { variant: 'default', label: 'Đã duyệt' },
      PARTIAL_PAID: { variant: 'secondary', label: 'Trả 1 phần' },
      PAID: { variant: 'default', label: 'Đã thanh toán' },
      OVERDUE: { variant: 'destructive', label: 'Quá hạn' },
      CANCELLED: { variant: 'destructive', label: 'Đã hủy' },
    };
    const config = variants[status] || { variant: 'outline' as const, label: status };
    return <Badge variant={config.variant}>{config.label}</Badge>;
  };

  const getHistoryTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      extension: 'Gia hạn hợp đồng',
      transfer: 'Chuyển đổi',
      termination: 'Thanh lý',
    };
    return labels[type] || type;
  };

  const getHistoryTypeIcon = (type: string) => {
    switch (type) {
      case 'extension':
        return <RefreshCw className="h-4 w-4 text-blue-500" />;
      case 'transfer':
        return <MoveRight className="h-4 w-4 text-purple-500" />;
      case 'termination':
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return <History className="h-4 w-4 text-gray-500" />;
    }
  };

  // Error states
  if (!id) {
    return (
      <MainLayout title="Lỗi" subtitle="Không tìm thấy hợp đồng" icon={FileText}>
        <div className="text-center py-12">
          <p className="text-gray-500">ID hợp đồng không hợp lệ</p>
          <Button onClick={() => navigate('/contracts')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
    );
  }

  if (contractLoading) {
    return (
      <MainLayout title="Đang tải..." subtitle="Vui lòng đợi" icon={FileText}>
        <div className="text-center py-12 text-gray-500">
          Đang tải thông tin hợp đồng...
        </div>
      </MainLayout>
    );
  }

  if (!contract) {
    return (
      <MainLayout title="Không tìm thấy" subtitle="Hợp đồng không tồn tại" icon={FileText}>
        <div className="text-center py-12">
          <p className="text-gray-500">Không tìm thấy hợp đồng với ID này</p>
          <Button onClick={() => navigate('/contracts')} className="mt-4">
            Quay lại danh sách
          </Button>
        </div>
      </MainLayout>
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
  const isActive = contract.status === 'ACTIVE';

  // Calculate total paid and outstanding from invoices
  const totalInvoiced = invoices?.reduce((sum, inv) => sum + (inv.total_amount || 0), 0) || 0;
  const totalPaid = invoices?.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0) || 0;
  const outstandingAmount = totalInvoiced - totalPaid;

  return (
    <MainLayout
      title={`Hợp đồng ${contract.contract_number || contract.id.slice(0, 8)}`}
      subtitle="Chi tiết hợp đồng"
      icon={FileText}
    >
      {/* Header Actions */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button
          variant="outline"
          onClick={() => navigate('/contracts')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Quay lại
        </Button>

        <div className="flex-1" />

        {isActive && (
          <>
            <Button
              variant="outline"
              onClick={() => setExtendDialogOpen(true)}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Gia hạn
            </Button>

            <Button
              variant="outline"
              onClick={() => setTransferDialogOpen(true)}
            >
              <MoveRight className="h-4 w-4 mr-2" />
              Chuyển đổi
            </Button>

            <Button
              variant="outline"
              onClick={() => setMoveOutDialogOpen(true)}
            >
              <Calendar className="h-4 w-4 mr-2" />
              Đăng ký chuyển đi
            </Button>

            <Button
              variant="destructive"
              onClick={() => setTerminateDialogOpen(true)}
            >
              <XCircle className="h-4 w-4 mr-2" />
              Thanh lý
            </Button>
          </>
        )}
      </div>

      {/* Alerts */}
      {isExpiringSoon && isActive && (
        <Alert className="mb-6 bg-orange-50 border-orange-200">
          <AlertCircle className="h-4 w-4 text-orange-600" />
          <AlertDescription className="text-orange-800">
            Hợp đồng sẽ hết hạn trong {daysRemaining} ngày. Vui lòng liên hệ khách thuê để gia hạn.
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
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Column - Main Info */}
            <div className="lg:col-span-2 space-y-6">
              {/* Contract Details Card */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5" />
                      Thông tin hợp đồng
                    </CardTitle>
                    {getStatusBadge(contract.status)}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-gray-600">Số hợp đồng</div>
                      <div className="font-medium">{contract.contract_number || 'N/A'}</div>
                    </div>
                    <div>
                      <div className="text-gray-600">Ngày ký</div>
                      <div className="font-medium">
                        {contract.signed_date
                          ? format(new Date(contract.signed_date), 'dd/MM/yyyy', { locale: vi })
                          : 'N/A'
                        }
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600">Ngày bắt đầu</div>
                      <div className="font-medium">
                        {format(new Date(contract.start_date), 'dd/MM/yyyy', { locale: vi })}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600">Ngày kết thúc</div>
                      <div className={`font-medium ${isExpiringSoon ? 'text-orange-600' : ''} ${isExpired ? 'text-red-600' : ''}`}>
                        {format(new Date(contract.end_date), 'dd/MM/yyyy', { locale: vi })}
                        {isExpiringSoon && <span className="ml-2 text-xs">({daysRemaining} ngày)</span>}
                        {isExpired && <span className="ml-2 text-xs">(Đã hết hạn)</span>}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600">Giá thuê</div>
                      <div className="font-medium text-green-600">
                        {formatCurrency(contract.rent_price || 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-gray-600">Chu kỳ thanh toán</div>
                      <div className="font-medium">
                        {getPaymentCycleLabel(contract.payment_cycle)}
                      </div>
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="pt-4 border-t">
                    <div className="flex justify-between text-sm text-gray-600 mb-2">
                      <span>Tiến độ hợp đồng</span>
                      <span>{Math.round(progressPercent)}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full ${isExpired ? 'bg-red-500' : isExpiringSoon ? 'bg-orange-500' : 'bg-green-500'}`}
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>

                  {contract.notes && (
                    <div className="pt-4 border-t">
                      <div className="text-gray-600 text-sm mb-1">Ghi chú</div>
                      <div className="text-sm bg-gray-50 p-3 rounded">{contract.notes}</div>
                    </div>
                  )}

                  {contract.contract_file_url && (
                    <div className="pt-4 border-t">
                      <a
                        href={contract.contract_file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 hover:underline text-sm"
                      >
                        <FileText className="h-4 w-4" />
                        Xem file hợp đồng
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Tenant Info Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <User className="h-5 w-5" />
                    Thông tin khách thuê
                    {contractTenants.length > 1 && (
                      <Badge variant="secondary" className="ml-2">
                        {contractTenants.length} người
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {contractTenants.length > 0 ? (
                    <div className="space-y-4">
                      {contractTenants.map((ct, index) => (
                        <div key={ct.id} className={index > 0 ? 'pt-4 border-t' : ''}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-medium text-sm">
                              {ct.tenant?.full_name || 'N/A'}
                            </span>
                            {ct.is_representative && (
                              <Badge variant="default" className="text-xs bg-green-500 hover:bg-green-600">
                                Đại diện
                              </Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <div className="text-gray-600 flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                Số điện thoại
                              </div>
                              <div className="font-medium">{ct.tenant?.phone || 'N/A'}</div>
                            </div>
                            <div>
                              <div className="text-gray-600 flex items-center gap-1">
                                <Mail className="h-3 w-3" />
                                Email
                              </div>
                              <div className="font-medium">{ct.tenant?.email || 'N/A'}</div>
                            </div>
                          </div>
                          <div className="mt-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => navigate(`/tenants/${ct.tenant_id}`)}
                            >
                              Xem chi tiết
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <div className="text-gray-600">Họ tên</div>
                          <div className="font-medium">{contract.tenant?.full_name || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-gray-600 flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            Số điện thoại
                          </div>
                          <div className="font-medium">{contract.tenant?.phone || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-gray-600 flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            Email
                          </div>
                          <div className="font-medium">{contract.tenant?.email || 'N/A'}</div>
                        </div>
                        <div>
                          <div className="text-gray-600 flex items-center gap-1">
                            <CreditCard className="h-3 w-3" />
                            CCCD/CMND
                          </div>
                          <div className="font-medium">
                            {(contract.tenant as any)?.id_number || 'N/A'}
                          </div>
                        </div>
                      </div>
                      <div className="mt-4 pt-4 border-t">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/tenants/${contract.tenant_id}`)}
                        >
                          Xem chi tiết khách thuê
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Location Info Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Home className="h-5 w-5" />
                    Thông tin phòng
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-gray-600">Vị trí</div>
                      <div className="font-medium">{getLocationDisplay(contract)}</div>
                    </div>
                    <div>
                      <div className="text-gray-600 flex items-center gap-1">
                        <Building2 className="h-3 w-3" />
                        Tòa nhà
                      </div>
                      <div className="font-medium">
                        {contract.room?.building.name || contract.bed?.room.building.name || 'N/A'}
                      </div>
                    </div>
                    {contract.initial_electricity_reading !== null && (
                      <div>
                        <div className="text-gray-600 flex items-center gap-1">
                          <Zap className="h-3 w-3 text-yellow-500" />
                          Chỉ số điện ban đầu
                        </div>
                        <div className="font-medium">{contract.initial_electricity_reading} kWh</div>
                      </div>
                    )}
                    {contract.initial_water_reading !== null && (
                      <div>
                        <div className="text-gray-600 flex items-center gap-1">
                          <Droplets className="h-3 w-3 text-blue-500" />
                          Chỉ số nước ban đầu
                        </div>
                        <div className="font-medium">{contract.initial_water_reading} m³</div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Right Column - Summary */}
            <div className="space-y-6">
              {/* Deposit Summary Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <DollarSign className="h-5 w-5" />
                    Tiền cọc
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tổng tiền cọc:</span>
                      <span className="font-bold">{formatCurrency(contract.total_deposit || 0)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Đã thu:</span>
                      <span className="font-medium text-green-600">
                        {formatCurrency(contract.deposit_paid || 0)}
                      </span>
                    </div>
                    <div className="border-t pt-2 flex justify-between">
                      <span className="text-gray-900 font-medium">Còn lại:</span>
                      <span className={`font-bold ${(contract.deposit_remaining || 0) > 0 ? 'text-orange-600' : 'text-gray-500'}`}>
                        {formatCurrency(contract.deposit_remaining || 0)}
                      </span>
                    </div>
                  </div>

                  {(contract.deposit_remaining || 0) <= 0 && (
                    <Alert className="bg-green-50 border-green-200">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <AlertDescription className="text-green-800 text-sm">
                        Đã thu đủ tiền cọc
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>

              {/* Invoice Summary Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Receipt className="h-5 w-5" />
                    Tóm tắt hóa đơn
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tổng hóa đơn:</span>
                      <span className="font-medium">{invoices?.length || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Tổng phát sinh:</span>
                      <span className="font-bold">{formatCurrency(totalInvoiced)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600">Đã thanh toán:</span>
                      <span className="font-medium text-green-600">{formatCurrency(totalPaid)}</span>
                    </div>
                    <div className="border-t pt-2 flex justify-between">
                      <span className="text-gray-900 font-medium">Công nợ:</span>
                      <span className={`font-bold text-lg ${outstandingAmount > 0 ? 'text-red-600' : 'text-gray-500'}`}>
                        {formatCurrency(outstandingAmount)}
                      </span>
                    </div>
                  </div>

                  {outstandingAmount <= 0 && invoices && invoices.length > 0 && (
                    <Alert className="bg-green-50 border-green-200">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <AlertDescription className="text-green-800 text-sm">
                        Không có công nợ
                      </AlertDescription>
                    </Alert>
                  )}

                  {outstandingAmount > 0 && (
                    <Alert className="bg-red-50 border-red-200">
                      <AlertCircle className="h-4 w-4 text-red-600" />
                      <AlertDescription className="text-red-800 text-sm">
                        Còn công nợ cần thu
                      </AlertDescription>
                    </Alert>
                  )}
                </CardContent>
              </Card>

              {/* Quick Stats */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="h-5 w-5" />
                    Thời gian
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tổng thời hạn:</span>
                    <span className="font-medium">{totalDays} ngày</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Đã thuê:</span>
                    <span className="font-medium">{Math.max(daysElapsed, 0)} ngày</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Còn lại:</span>
                    <span className={`font-medium ${daysRemaining < 0 ? 'text-red-600' : daysRemaining <= 30 ? 'text-orange-600' : ''}`}>
                      {daysRemaining < 0 ? `Quá hạn ${Math.abs(daysRemaining)} ngày` : `${daysRemaining} ngày`}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* Tab 2: Services */}
        <TabsContent value="services">
          <Card>
            <CardHeader>
              <CardTitle>Dịch vụ đã đăng ký</CardTitle>
              <CardDescription>
                Danh sách các dịch vụ của hợp đồng
              </CardDescription>
            </CardHeader>
            <CardContent>
              {servicesLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : contractServices.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Không có dịch vụ nào được đăng ký
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dịch vụ</TableHead>
                      <TableHead>Loại</TableHead>
                      <TableHead>Đơn vị</TableHead>
                      <TableHead className="text-right">Đơn giá</TableHead>
                      <TableHead className="text-right">Chỉ số ban đầu</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contractServices.map((cs) => (
                      <TableRow key={cs.id}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            {getServiceTypeIcon(cs.service.type)}
                            {cs.service.name}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {getServiceTypeLabel(cs.service.type)}
                          </Badge>
                        </TableCell>
                        <TableCell>{cs.service.unit || '-'}</TableCell>
                        <TableCell className="text-right font-medium">
                          {formatCurrency(cs.unit_price)}
                        </TableCell>
                        <TableCell className="text-right">
                          {cs.initial_reading !== null ? cs.initial_reading : '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Invoices */}
        <TabsContent value="invoices">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Hóa đơn</CardTitle>
                  <CardDescription>
                    Danh sách hóa đơn của hợp đồng ({invoices?.length || 0} hóa đơn)
                  </CardDescription>
                </div>
                <Button variant="outline" onClick={() => navigate('/invoices')}>
                  <Receipt className="h-4 w-4 mr-2" />
                  Tạo hóa đơn
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {invoicesLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : !invoices || invoices.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có hóa đơn nào
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Số hóa đơn</TableHead>
                      <TableHead>Kỳ thanh toán</TableHead>
                      <TableHead>Hạn thanh toán</TableHead>
                      <TableHead className="text-right">Tổng tiền</TableHead>
                      <TableHead className="text-right">Đã thu</TableHead>
                      <TableHead className="text-right">Còn lại</TableHead>
                      <TableHead>Trạng thái</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((invoice) => {
                      const remaining = (invoice.total_amount || 0) - (invoice.paid_amount || 0);
                      return (
                        <TableRow key={invoice.id}>
                          <TableCell className="font-medium">
                            {invoice.title || invoice.invoice_number || invoice.id.slice(0, 8)}
                          </TableCell>
                          <TableCell>
                            {invoice.billing_period_start && invoice.billing_period_end && (
                              <>
                                {format(new Date(invoice.billing_period_start), 'dd/MM', { locale: vi })}
                                {' - '}
                                {format(new Date(invoice.billing_period_end), 'dd/MM/yyyy', { locale: vi })}
                              </>
                            )}
                          </TableCell>
                          <TableCell>
                            {invoice.due_date && format(new Date(invoice.due_date), 'dd/MM/yyyy', { locale: vi })}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(invoice.total_amount || 0)}
                          </TableCell>
                          <TableCell className="text-right text-green-600">
                            {formatCurrency(invoice.paid_amount || 0)}
                          </TableCell>
                          <TableCell className={`text-right ${remaining > 0 ? 'text-orange-600' : ''}`}>
                            {formatCurrency(remaining)}
                          </TableCell>
                          <TableCell>
                            {getInvoiceStatusBadge(invoice.status)}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/invoices/${invoice.id}`)}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 4: Payments */}
        <TabsContent value="payments">
          <Card>
            <CardHeader>
              <CardTitle>Lịch sử thanh toán</CardTitle>
              <CardDescription>
                Các khoản thanh toán đã ghi nhận
              </CardDescription>
            </CardHeader>
            <CardContent>
              {invoicesLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : (
                <>
                  {/* Collect all payments from all invoices */}
                  {(() => {
                    const allPayments = invoices?.flatMap(inv =>
                      (inv.payments || []).map(p => ({ ...p, invoice: inv }))
                    ) || [];

                    if (allPayments.length === 0) {
                      return (
                        <div className="text-center py-8 text-gray-500">
                          Chưa có thanh toán nào
                        </div>
                      );
                    }

                    // Sort by payment date descending
                    allPayments.sort((a, b) =>
                      new Date(b.payment_date).getTime() - new Date(a.payment_date).getTime()
                    );

                    return (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Ngày thanh toán</TableHead>
                            <TableHead>Hóa đơn</TableHead>
                            <TableHead className="text-right">Số tiền</TableHead>
                            <TableHead>Phương thức</TableHead>
                            <TableHead>Ghi chú</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {allPayments.map((payment) => (
                            <TableRow key={payment.id}>
                              <TableCell>
                                {format(new Date(payment.payment_date), 'dd/MM/yyyy HH:mm', { locale: vi })}
                              </TableCell>
                              <TableCell className="font-medium">
                                {payment.invoice.title || payment.invoice.invoice_number}
                              </TableCell>
                              <TableCell className="text-right font-medium text-green-600">
                                {formatCurrency(payment.amount)}
                              </TableCell>
                              <TableCell className="capitalize">
                                {payment.payment_method?.toLowerCase().replace('_', ' ')}
                              </TableCell>
                              <TableCell className="text-gray-500 text-sm">
                                {payment.notes || '-'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    );
                  })()}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 5: History */}
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Lịch sử thay đổi</CardTitle>
              <CardDescription>
                Các hoạt động gia hạn, chuyển đổi, thanh lý
              </CardDescription>
            </CardHeader>
            <CardContent>
              {historyLoading ? (
                <div className="text-center py-8 text-gray-500">
                  Đang tải...
                </div>
              ) : contractHistory.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  Chưa có lịch sử thay đổi
                </div>
              ) : (
                <div className="space-y-4">
                  {contractHistory.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-start gap-4 p-4 rounded-lg border bg-gray-50"
                    >
                      <div className="flex-shrink-0 mt-1">
                        {getHistoryTypeIcon(item.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium">{getHistoryTypeLabel(item.type)}</span>
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              item.status === 'PENDING_APPROVAL' ? 'bg-orange-100 text-orange-800 border-orange-300' :
                              item.status === 'APPROVED' || item.status === 'COMPLETED' ? 'bg-green-100 text-green-800 border-green-300' :
                              item.status === 'DRAFT' ? 'bg-gray-100 text-gray-800' : ''
                            }`}
                          >
                            {item.status === 'DRAFT' ? 'Nháp' :
                             item.status === 'PENDING_APPROVAL' ? 'Chờ duyệt' :
                             item.status === 'APPROVED' ? 'Đã duyệt' :
                             item.status === 'COMPLETED' ? 'Hoàn thành' :
                             item.status === 'CANCELLED' ? 'Đã hủy' :
                             item.status}
                          </Badge>
                        </div>
                        <div className="text-sm text-gray-600">
                          {format(new Date(item.created_at), 'dd/MM/yyyy HH:mm', { locale: vi })}
                        </div>
                        {item.type === 'extension' && item.details.extension_months && (
                          <div className="text-sm mt-1">
                            Gia hạn {item.details.extension_months} tháng
                            {item.details.new_rent_price && (
                              <> - Giá mới: {formatCurrency(item.details.new_rent_price)}</>
                            )}
                          </div>
                        )}
                        {item.type === 'transfer' && (
                          <div className="text-sm mt-1">
                            Loại: {item.details.transfer_type?.replace('_', ' ')}
                          </div>
                        )}
                        {item.type === 'termination' && (
                          <div className="text-sm mt-1">
                            Loại: {item.details.termination_type}
                            {item.details.actual_move_out_date && (
                              <> - Ngày trả phòng: {format(new Date(item.details.actual_move_out_date), 'dd/MM/yyyy', { locale: vi })}</>
                            )}
                            {(item.status === 'DRAFT' || item.status === 'PENDING_APPROVAL') && (
                              <div className="mt-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-blue-600 border-blue-300 hover:bg-blue-50"
                                  onClick={() => navigate('/contracts/termination-approvals')}
                                >
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Đi đến duyệt thanh lý
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                        {item.details.notes && (
                          <div className="text-sm text-gray-500 mt-1">
                            Ghi chú: {item.details.notes}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <ExtendContractDialog
        open={extendDialogOpen}
        onOpenChange={setExtendDialogOpen}
        contract={contract}
      />

      <TransferContractDialog
        open={transferDialogOpen}
        onOpenChange={setTransferDialogOpen}
        contract={contract}
      />

      <TerminateContractDialog
        open={terminateDialogOpen}
        onOpenChange={setTerminateDialogOpen}
        contract={contract}
      />

      <RegisterMoveOutDialog
        open={moveOutDialogOpen}
        onOpenChange={setMoveOutDialogOpen}
        contract={contract}
      />
    </MainLayout>
  );
};

export default ContractDetailPage;
