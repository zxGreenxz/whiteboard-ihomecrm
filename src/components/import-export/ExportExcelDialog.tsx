import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Download, FileSpreadsheet, Loader2, CheckCircle } from 'lucide-react';
import {
  exportBuildings,
  exportRooms,
  exportTenants,
  exportContracts,
  exportInvoices,
  exportLeads,
  exportPayments,
} from '@/lib/excelHelpers';
import { supabase } from '@/integrations/supabase/client';

interface ExportExcelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportType: 'buildings' | 'rooms' | 'tenants' | 'contracts' | 'invoices' | 'leads' | 'payments';
  filters?: Record<string, any>;
}

const ExportExcelDialog = ({
  open,
  onOpenChange,
  exportType,
  filters = {},
}: ExportExcelDialogProps) => {
  const [isExporting, setIsExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [includeRelations, setIncludeRelations] = useState(true);
  const [success, setSuccess] = useState(false);

  const config = {
    buildings: {
      title: 'Xuất danh sách Tòa nhà',
      description: 'Xuất toàn bộ hoặc một phần danh sách tòa nhà ra file Excel',
    },
    rooms: {
      title: 'Xuất danh sách Phòng',
      description: 'Xuất toàn bộ hoặc một phần danh sách phòng ra file Excel',
    },
    tenants: {
      title: 'Xuất danh sách Khách thuê',
      description: 'Xuất toàn bộ hoặc một phần danh sách khách thuê ra file Excel',
    },
    contracts: {
      title: 'Xuất danh sách Hợp đồng',
      description: 'Xuất toàn bộ hoặc một phần danh sách hợp đồng ra file Excel',
    },
    invoices: {
      title: 'Xuất danh sách Hóa đơn',
      description: 'Xuất toàn bộ hoặc một phần danh sách hóa đơn ra file Excel',
    },
    leads: {
      title: 'Xuất danh sách Khách hẹn',
      description: 'Xuất toàn bộ hoặc một phần danh sách khách hẹn ra file Excel',
    },
    payments: {
      title: 'Xuất danh sách Thanh toán',
      description: 'Xuất toàn bộ hoặc một phần danh sách thanh toán ra file Excel',
    },
  };

  const currentConfig = config[exportType];

  const fetchData = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    let query;

    switch (exportType) {
      case 'buildings':
        query = supabase
          .from('buildings')
          .select(includeRelations ? '*, area:areas(name)' : '*')
          .eq('user_id', user.id)
          .is('deleted_at', null);
        break;

      case 'rooms':
        query = supabase
          .from('rooms')
          .select(includeRelations ? '*, building:buildings(name)' : '*')
          .eq('user_id', user.id)
          .is('deleted_at', null);
        break;

      case 'tenants':
        query = supabase
          .from('tenants')
          .select('*')
          .eq('user_id', user.id)
          .is('deleted_at', null);
        break;

      case 'contracts':
        query = supabase
          .from('contracts')
          .select(includeRelations
            ? '*, tenant:tenants(full_name), room:rooms(name, building:buildings(name))'
            : '*')
          .eq('user_id', user.id)
          .is('deleted_at', null);
        break;

      case 'invoices':
        query = supabase
          .from('invoices')
          .select(includeRelations
            ? '*, contract:contracts(contract_number, tenant:tenants(full_name))'
            : '*')
          .eq('user_id', user.id)
          .is('deleted_at', null);
        break;

      case 'leads':
        query = supabase
          .from('leads')
          .select(includeRelations
            ? '*, room:rooms(name, building:buildings(name))'
            : '*')
          .eq('user_id', user.id)
          .is('deleted_at', null);
        break;

      case 'payments':
        query = supabase
          .from('payments')
          .select(includeRelations
            ? '*, invoice:invoices(invoice_number, contract:contracts(contract_number, tenant:tenants(full_name, phone)))'
            : '*')
          .eq('user_id', user.id);
        break;

      default:
        throw new Error('Invalid export type');
    }

    // Apply filters
    if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.building_id) {
      query = query.eq('building_id', filters.building_id);
    }
    if (filters.from_date) {
      query = query.gte('created_at', filters.from_date);
    }
    if (filters.to_date) {
      query = query.lte('created_at', filters.to_date);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  };

  const handleExport = async () => {
    setIsExporting(true);
    setSuccess(false);

    try {
      const data = await fetchData();

      switch (exportType) {
        case 'buildings':
          exportBuildings(data);
          break;
        case 'rooms':
          exportRooms(data);
          break;
        case 'tenants':
          exportTenants(data);
          break;
        case 'contracts':
          exportContracts(data);
          break;
        case 'invoices':
          exportInvoices(data);
          break;
        case 'leads':
          exportLeads(data);
          break;
        case 'payments':
          exportPayments(data);
          break;
      }

      setSuccess(true);
    } catch (error) {
      console.error('Export error:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const handleClose = () => {
    setSuccess(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            {currentConfig.title}
          </DialogTitle>
          <DialogDescription>{currentConfig.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Format Selection */}
          <div className="space-y-3">
            <Label>Định dạng file</Label>
            <RadioGroup
              value={exportFormat}
              onValueChange={(v) => setExportFormat(v as 'xlsx' | 'csv')}
              className="flex gap-4"
            >
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="xlsx" id="xlsx" />
                <Label htmlFor="xlsx" className="font-normal cursor-pointer">
                  Excel (.xlsx)
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="csv" id="csv" disabled />
                <Label htmlFor="csv" className="font-normal cursor-pointer text-gray-400">
                  CSV (.csv) - Sắp có
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Include Relations */}
          {['buildings', 'rooms', 'contracts', 'invoices', 'leads', 'payments'].includes(exportType) && (
            <div className="flex items-center space-x-2">
              <Checkbox
                id="includeRelations"
                checked={includeRelations}
                onCheckedChange={(checked) => setIncludeRelations(checked as boolean)}
              />
              <Label htmlFor="includeRelations" className="font-normal cursor-pointer">
                Bao gồm thông tin liên quan (tên tòa nhà, khách thuê, v.v.)
              </Label>
            </div>
          )}

          {/* Filter Summary */}
          {Object.keys(filters).length > 0 && (
            <Alert>
              <AlertDescription>
                Đang áp dụng bộ lọc. Chỉ xuất các bản ghi phù hợp.
              </AlertDescription>
            </Alert>
          )}

          {/* Success Message */}
          {success && (
            <Alert className="bg-green-50 border-green-200">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <AlertDescription className="text-green-800">
                Xuất file thành công! File đã được tải xuống.
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {success ? 'Đóng' : 'Hủy'}
          </Button>
          <Button onClick={handleExport} disabled={isExporting}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Đang xuất...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Xuất file
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ExportExcelDialog;
