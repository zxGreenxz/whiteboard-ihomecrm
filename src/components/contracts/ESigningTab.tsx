import { useState } from 'react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PenTool,
  Send,
  Eye,
  CheckCircle,
  Clock,
  FileText,
  Link2,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useContractsLegacy, type ContractWithRelations } from '@/hooks/useContracts';
import { getRepresentativeEmail, getRepresentativeName } from '@/lib/contractCustomerHelpers';

// E-signing status types
type ESigningStatus = 'NOT_SENT' | 'SENT' | 'VIEWED' | 'SIGNED';

interface ESigningRecord {
  contractId: string;
  contractNumber: string;
  tenantName: string;
  tenantEmail: string;
  roomName: string;
  status: ESigningStatus;
  sentAt?: string;
  viewedAt?: string;
  signedAt?: string;
  signingLink?: string;
}

const getStatusBadge = (status: ESigningStatus) => {
  const config: Record<ESigningStatus, { variant: 'outline' | 'default' | 'secondary' | 'destructive'; label: string }> = {
    NOT_SENT: { variant: 'outline', label: 'Chưa gửi' },
    SENT: { variant: 'secondary', label: 'Đã gửi link' },
    VIEWED: { variant: 'secondary', label: 'Đã xem' },
    SIGNED: { variant: 'default', label: 'Đã ký' },
  };
  const c = config[status];
  return <Badge variant={c.variant}>{c.label}</Badge>;
};

const ESigningTab = () => {
  const { data: contracts, isLoading } = useContractsLegacy({ status: 'ACTIVE' });
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [selectedContract, setSelectedContract] = useState<ContractWithRelations | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [signingRecords, setSigningRecords] = useState<ESigningRecord[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const handleSendSigningLink = () => {
    if (!selectedContract || !recipientEmail) {
      toast.error('Vui lòng nhập email người nhận');
      return;
    }

    const tenantName = getRepresentativeName(selectedContract as any, 'N/A');

    const roomName = selectedContract.room
      ? `${selectedContract.room.building?.name} - ${selectedContract.room.name}`
      : selectedContract.bed
        ? `${selectedContract.bed.room?.building?.name} - ${selectedContract.bed.room?.name} - ${selectedContract.bed.name}`
        : 'N/A';

    const mockLink = `https://app.resident.vn/sign/${selectedContract.id.slice(0, 8)}`;

    const newRecord: ESigningRecord = {
      contractId: selectedContract.id,
      contractNumber: selectedContract.contract_number || selectedContract.id.slice(0, 8),
      tenantName,
      tenantEmail: recipientEmail,
      roomName,
      status: 'SENT',
      sentAt: new Date().toISOString(),
      signingLink: mockLink,
    };

    setSigningRecords(prev => {
      const existing = prev.findIndex(r => r.contractId === selectedContract.id);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = newRecord;
        return updated;
      }
      return [...prev, newRecord];
    });

    toast.success(`Đã gửi link ký hợp đồng đến ${recipientEmail}`);
    setSendDialogOpen(false);
    setRecipientEmail('');
    setSelectedContract(null);
  };

  const handleCopyLink = (link: string) => {
    navigator.clipboard.writeText(link);
    toast.success('Đã sao chép link ký hợp đồng');
  };

  const handleMockSign = (contractId: string) => {
    setSigningRecords(prev =>
      prev.map(r =>
        r.contractId === contractId
          ? { ...r, status: 'SIGNED' as ESigningStatus, signedAt: new Date().toISOString() }
          : r
      )
    );
    toast.success('Hợp đồng đã được ký thành công');
  };

  const filteredRecords = filterStatus === 'all'
    ? signingRecords
    : signingRecords.filter(r => r.status === filterStatus);

  const activeContracts = Array.isArray(contracts) ? contracts : [];

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Tổng HĐ đang hoạt động</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeContracts.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Đã gửi link ký</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {signingRecords.filter(r => r.status === 'SENT' || r.status === 'VIEWED').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Đã ký</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {signingRecords.filter(r => r.status === 'SIGNED').length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Chưa gửi</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-gray-500">
              {activeContracts.length - signingRecords.length}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Landlord Flow: Send signing links */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PenTool className="h-5 w-5" />
            Ký hợp đồng điện tử
          </CardTitle>
          <CardDescription>
            Gửi link ký hợp đồng cho khách hàng. Khách hàng nhận link → Xem hợp đồng → Ký điện tử.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Filter */}
          <div className="flex gap-4 mb-4">
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Lọc trạng thái" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả</SelectItem>
                <SelectItem value="NOT_SENT">Chưa gửi</SelectItem>
                <SelectItem value="SENT">Đã gửi link</SelectItem>
                <SelectItem value="VIEWED">Đã xem</SelectItem>
                <SelectItem value="SIGNED">Đã ký</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-gray-500">Đang tải dữ liệu...</div>
          ) : activeContracts.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              Chưa có hợp đồng đang hoạt động nào.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã HĐ</TableHead>
                  <TableHead>Khách hàng</TableHead>
                  <TableHead>Căn hộ</TableHead>
                  <TableHead>Trạng thái ký</TableHead>
                  <TableHead>Ngày gửi</TableHead>
                  <TableHead>Ngày ký</TableHead>
                  <TableHead className="text-right">Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(filterStatus === 'all' || filterStatus === 'NOT_SENT'
                  ? activeContracts
                  : activeContracts.filter(c => signingRecords.some(r => r.contractId === c.id && r.status === filterStatus))
                ).map((contract) => {
                  const record = signingRecords.find(r => r.contractId === contract.id);
                  const tenantName = getRepresentativeName(contract as any, 'N/A');
                  const roomName = contract.room
                    ? `${contract.room.building?.name} - ${contract.room.name}`
                    : contract.bed
                      ? `${contract.bed.room?.building?.name} - ${contract.bed.room?.name} - ${contract.bed.name}`
                      : 'N/A';

                  // Apply filter for NOT_SENT
                  if (filterStatus === 'NOT_SENT' && record) return null;
                  if (filterStatus !== 'all' && filterStatus !== 'NOT_SENT' && !record) return null;

                  return (
                    <TableRow key={contract.id}>
                      <TableCell className="font-medium">
                        {contract.contract_number || contract.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>{tenantName}</TableCell>
                      <TableCell>{roomName}</TableCell>
                      <TableCell>
                        {record ? getStatusBadge(record.status) : getStatusBadge('NOT_SENT')}
                      </TableCell>
                      <TableCell>
                        {record?.sentAt
                          ? format(new Date(record.sentAt), 'dd/MM/yyyy HH:mm', { locale: vi })
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {record?.signedAt
                          ? format(new Date(record.signedAt), 'dd/MM/yyyy HH:mm', { locale: vi })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {!record || record.status === 'NOT_SENT' ? (
                            <Button
                              size="sm"
                              onClick={() => {
                                setSelectedContract(contract);
                                const email = getRepresentativeEmail(contract as any, '');
                                setRecipientEmail(email || '');
                                setSendDialogOpen(true);
                              }}
                            >
                              <Send className="h-4 w-4 mr-1" />
                              Gửi link ký
                            </Button>
                          ) : (
                            <>
                              {record.signingLink && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleCopyLink(record.signingLink!)}
                                >
                                  <Copy className="h-4 w-4 mr-1" />
                                  Sao chép link
                                </Button>
                              )}
                              {record.status === 'SENT' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleMockSign(contract.id)}
                                  title="Mô phỏng khách hàng ký hợp đồng"
                                >
                                  <CheckCircle className="h-4 w-4 mr-1" />
                                  Mô phỏng ký
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Send Signing Link Dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="h-5 w-5" />
              Gửi link ký hợp đồng
            </DialogTitle>
            <DialogDescription>
              Gửi link ký hợp đồng điện tử cho khách hàng qua email.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Hợp đồng</Label>
              <Input
                value={selectedContract?.contract_number || selectedContract?.id.slice(0, 8) || ''}
                disabled
              />
            </div>
            <div>
              <Label>Email người nhận</Label>
              <Input
                type="email"
                placeholder="Nhập email khách hàng..."
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSendDialogOpen(false)}>
              Hủy
            </Button>
            <Button onClick={handleSendSigningLink}>
              <Send className="h-4 w-4 mr-2" />
              Gửi link ký
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ESigningTab;
