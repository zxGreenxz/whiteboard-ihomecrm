/**
 * ContractImportExportDialog
 * Dialog for importing contracts from Excel and exporting contract list.
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2
 */

import { useRef, useState, useMemo, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  downloadContractImportTemplate,
  parseContractExcel,
  exportContracts,
  type ContractImportRow,
} from '@/lib/contractExcelHelpers';
import type { ImportResult } from '@/lib/excelHelpers';
import type { ContractWithRelations, ContractFilters } from '@/types/contract';
import { useBuildings } from '@/hooks/useBuildings';
import type { BuildingWithRelations } from '@/types/building';
import {
  Download,
  Upload,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
type ContractImportInsert=Database['public']['Tables']['contracts']['Insert'];
import { getSessionUser } from "@/lib/authSession";
import { useOrganization } from '@/contexts/OrganizationContext';
import { withOrg } from '@/lib/orgPayload';
import { importContractBatch, readContractImportPending, type ContractImportReport, type ContractImportProgressRow } from '@/lib/contractImportWorkflow';
import { matchesContractMoneyReceipt } from '@/lib/contractMoneyReceipt';
import { confirmedRecordId } from '@/lib/recordWriteOutcome';
import { friendlyError } from '@/lib/friendlyError';

// =============================================
// Props
// =============================================

interface ContractImportExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'import' | 'export';
  currentFilters?: ContractFilters;
  contracts?: ContractWithRelations[];
}

// =============================================
// Component
// =============================================

export function ContractImportExportDialog({
  open,
  onOpenChange,
  mode,
  currentFilters,
  contracts,
}: ContractImportExportDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string>('');
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parseResult, setParseResult] = useState<ImportResult<ContractImportRow> | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ContractImportReport | null>(null);
  const [blocked,setBlocked]=useState(false);
  const [pendingChecked,setPendingChecked]=useState(false);
  const importing=useRef(false);

  const { selectedOrganizationId } = useOrganization();
  const { data: buildingsData } = useBuildings({ enabled: open });
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as BuildingWithRelations[],
    [buildingsData]
  );

  useEffect(()=>{let active=true;if(!open||mode!=='import')return;setPendingChecked(false);setBlocked(false);setImportResult(null);setParseError(null);
    void getSessionUser().then(user=>{if(!active)return;if(!user||!selectedOrganizationId)throw new Error('Chưa đăng nhập hoặc chưa chọn tổ chức');
      const pending=readContractImportPending({userId:user.id,organizationId:selectedOrganizationId});if(pending){setImportResult(pending);setSelectedBuildingId(pending.buildingId);setBlocked(!pending.canCorrect);}
    }).catch(error=>{if(active){setBlocked(true);setParseError(friendlyError(error,'Chưa đối chiếu lượt nhập trước').description);}}).finally(()=>{if(active)setPendingChecked(true);});return()=>{active=false;};
  },[open,mode,selectedOrganizationId]);

  // ---- handlers ----

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if(blocked||importing.current)return;
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setParseResult(null);
    setParseError(null);
    setImportResult(null);
  }

  function handleSelectFile() {
    if(!blocked&&!importing.current)fileInputRef.current?.click();
  }

  async function handleParse() {
    if (!selectedFile || !selectedBuildingId || blocked || importing.current || !pendingChecked) return;
    setIsParsing(true);
    setParseResult(null);
    setParseError(null);
    setImportResult(null);
    try {
      const result = await parseContractExcel(selectedFile, selectedBuildingId);
      setParseResult(result);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setIsParsing(false);
    }
  }

  async function handleConfirmImport() {
    if (!parseResult || !selectedBuildingId || !selectedOrganizationId || importing.current || blocked || !pendingChecked) return;
    const validRows = parseResult.success;if (!validRows.length) return;
    importing.current=true;setIsImporting(true);setParseError(null);
    try {
      const user=await getSessionUser();if(!user)throw {code:'PGRST301',message:'Not authenticated'};
      const [{data:rooms,error:roomsError},{data:existingCustomers,error:customersError}]=await Promise.all([
        supabase.from('rooms').select('id, name, code').eq('building_id',selectedBuildingId).is('deleted_at',null),
        supabase.from('customers').select('id, full_name, phone, id_number').is('deleted_at',null),
      ]);
      if(roomsError)throw roomsError;if(customersError)throw customersError;
      if(!rooms||!existingCustomers)throw new TypeError('Không tải được phòng hoặc khách hàng.');
      const customersList=[...existingCustomers];
      const findRoom=(row:ContractImportRow)=>rooms.find(room=>room.name?.toLowerCase()===row.room_name.toLowerCase()||room.code?.toLowerCase()===row.room_name.toLowerCase());
      const verifyCustomer=async(id:string,row:ContractImportRow)=>{const {data,error}=await supabase.from('customers').select('id, organization_id, phone').eq('id',id).maybeSingle();if(error)throw error;return !!data&&data.id===id&&data.organization_id===selectedOrganizationId&&data.phone===row.customer_phone;};
      const verify=async(entry:ContractImportProgressRow,input?:ContractImportRow)=>{
        if(!entry.contractId||!entry.roomId||!entry.customerId)return false;
        const [core,links,room]=await Promise.all([
          supabase.from('contracts').select('id, organization_id, room_id, signed_date, start_date, end_date, rent_price, total_deposit, status').eq('id',entry.contractId).maybeSingle(),
          supabase.from('contract_customers').select('contract_id, customer_id, is_representative').eq('contract_id',entry.contractId),
          supabase.from('rooms').select('id, organization_id, status').eq('id',entry.roomId).maybeSingle(),
        ]);
        if(core.error)throw core.error;if(links.error)throw links.error;if(room.error)throw room.error;
        return !!core.data&&core.data.id===entry.contractId&&core.data.organization_id===selectedOrganizationId&&core.data.room_id===entry.roomId&&core.data.status==='ACTIVE'
          &&!!room.data&&room.data.id===entry.roomId&&room.data.organization_id===selectedOrganizationId&&room.data.status==='OCCUPIED'
          &&Array.isArray(links.data)&&links.data.some(link=>link.contract_id===entry.contractId&&link.customer_id===entry.customerId&&link.is_representative)
          &&(!input||(core.data.signed_date===input.signed_date&&core.data.start_date===input.start_date&&core.data.end_date===input.end_date&&matchesContractMoneyReceipt(core.data.rent_price,input.rent_price)&&matchesContractMoneyReceipt(core.data.total_deposit,input.deposit)));
      };
      const result=await importContractBatch(validRows,{userId:user.id,organizationId:selectedOrganizationId,buildingId:selectedBuildingId},{
        customer:async(row,priorId)=>{
          if(!findRoom(row))throw {code:'22023',message:'Không tìm thấy phòng trong tòa đang nhập'};
          if(priorId)return {id:priorId,created:false};
          const existing=customersList.find(customer=>customer.phone===row.customer_phone);if(existing)return {id:existing.id,created:false};
          const {data,error}=await supabase.from('customers').insert(withOrg({user_id:user.id,full_name:row.customer_name,phone:row.customer_phone,id_number:row.customer_id_number||null},selectedOrganizationId)).select().single();if(error)throw error;
          const id=confirmedRecordId(data,'tạo khách nhập');customersList.push({id,full_name:row.customer_name,phone:row.customer_phone,id_number:row.customer_id_number||null});return {id,created:true};
        },
        contract:async(row,customerId)=>{
          const room=findRoom(row);if(!room)throw {code:'22023',message:'Không tìm thấy phòng trong tòa đang nhập'};
          const imported={user_id:user.id,tenant_id:customerId,room_id:room.id,signed_date:row.signed_date,start_date:row.start_date,end_date:row.end_date,rent_price:row.rent_price,payment_cycle:(row.payment_cycle||'MONTHLY') as NonNullable<ContractImportInsert['payment_cycle']>,total_deposit:row.deposit||0,deposit_paid:0,notes:row.notes||null,status:'ACTIVE'} satisfies Omit<ContractImportInsert,'public_code'>;
          // Parser accepts only MONTHLY/QUARTERLY/SEMI_ANNUAL/ANNUAL.
          // 20260530000003 trigger fills omitted public_code; generated Insert marks it required. Keep the existing payload.
          const {data,error}=await supabase.from('contracts').insert(withOrg(imported,selectedOrganizationId) as ContractImportInsert).select().single();if(error)throw error;
          return {id:confirmedRecordId(data,'tạo hợp đồng nhập'),roomId:room.id};
        },
        link:async(contractId,customerId)=>{const {error}=await supabase.from('contract_customers').insert(withOrg({contract_id:contractId,customer_id:customerId,is_representative:true},selectedOrganizationId));if(error)throw error;},
        occupy:async(roomId)=>{const {error}=await supabase.from('rooms').update({status:'OCCUPIED'}).eq('id',roomId);if(error)throw error;},verify,verifyCustomer,
      },report=>{setImportResult(report);setBlocked(report.pending&&!report.canCorrect);});
      if(result.failed>0){toast.error(`Đã nhập ${result.success} hợp đồng; ${result.failed} dòng cần kiểm tra. Giữ các ID đã tạo và đối chiếu trước khi nhập lại.`);}
      else if(result.success>0)toast.success(`Đã hoàn tất nhập ${result.success} hợp đồng.`);
    }catch(error){setParseError(friendlyError(error,'Chưa nhập được hợp đồng',{operation:'nhập hợp đồng từ Excel',financial:true}).description);}
    finally{importing.current=false;setIsImporting(false);}
  }

  function handleExport() {
    if (!contracts) return;
    exportContracts(contracts, currentFilters);
    handleClose();
  }

  function handleClose() {
    if(importing.current)return;
    onOpenChange(false);
    if(importResult?.pending||blocked)return;
    setTimeout(() => {
      setSelectedFile(null);
      setSelectedBuildingId('');
      setParseResult(null);
      setParseError(null);
      setImportResult(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }, 200);
  }

  // ---- derived ----

  const hasParseResult = parseResult !== null;
  const validCount = parseResult?.success.length ?? 0;
  const errorCount = parseResult?.errors.length ?? 0;
  const canParse = !!selectedFile && !!selectedBuildingId && !isParsing && !blocked && pendingChecked;
  const canConfirm = hasParseResult && validCount > 0 && !isImporting && !importResult && !blocked && pendingChecked;

  // ---- render ----

  if (mode === 'export') {
    // Export mode: just trigger download immediately
    if (open && contracts) {
      exportContracts(contracts, currentFilters);
      onOpenChange(false);
    }
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={value=>{if(!value)handleClose();}}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nhập dữ liệu hợp đồng</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step 1: Select building */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Bước 1: Chọn toà nhà</p>
            <Select value={selectedBuildingId} onValueChange={setSelectedBuildingId} disabled={isImporting || blocked}>
              <SelectTrigger>
                <SelectValue placeholder="Chọn toà nhà..." />
              </SelectTrigger>
              <SelectContent>
                {buildings.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Step 2: Download template */}
          <div className="flex items-center justify-between rounded-lg border p-3 bg-muted/40">
            <div>
              <p className="text-sm font-medium">Bước 2: Tải file mẫu</p>
              <p className="text-xs text-muted-foreground">
                Điền dữ liệu vào file mẫu trước khi nhập
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadContractImportTemplate}
            >
              <Download className="mr-2 h-4 w-4" />
              Tải file mẫu tại đây
            </Button>
          </div>

          {/* Step 3: Upload file */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Bước 3: Chọn file Excel</p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={handleFileChange}
            />

            <div
              onClick={handleSelectFile}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                if(blocked||importing.current)return;
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer.files?.[0];
                if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
                  setSelectedFile(file);
                  setParseResult(null);
                  setParseError(null);
                  setImportResult(null);
                }
              }}
              className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/30 p-8 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            >
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
              {selectedFile ? (
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(selectedFile.size / 1024).toFixed(1)} KB — Nhấn để đổi file
                  </p>
                </div>
              ) : (
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">
                    Nhấn để chọn file hoặc kéo thả vào đây
                  </p>
                  <p className="text-xs text-muted-foreground">Hỗ trợ .xlsx, .xls</p>
                </div>
              )}
            </div>
          </div>

          {/* Parse button */}
          {!importResult && (
            <Button
              onClick={handleParse}
              disabled={!canParse}
              className="w-full"
            >
              {isParsing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Đang xử lý...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Nhập dữ liệu
                </>
              )}
            </Button>
          )}

          {/* Parse error */}
          {parseError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{parseError}</AlertDescription>
            </Alert>
          )}

          {/* Parse result summary (before import) */}
          {hasParseResult && !importResult && (
            <div className="space-y-3">
              {errorCount === 0 ? (
                <Alert className="border-green-200 bg-green-50 text-green-800">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription>
                    {validCount} dòng hợp lệ, sẵn sàng nhập
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {validCount} dòng hợp lệ, {errorCount} dòng lỗi
                  </AlertDescription>
                </Alert>
              )}

              {/* Error table */}
              {errorCount > 0 && (
                <div className="rounded-md border overflow-hidden max-h-48 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Dòng</TableHead>
                        <TableHead>Lỗi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseResult!.errors.map((err) => (
                        <TableRow key={err.row}>
                          <TableCell className="font-medium">{err.row}</TableCell>
                          <TableCell className="text-destructive text-sm">
                            {err.message}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Confirm import button */}
              {canConfirm && (
                <Button onClick={handleConfirmImport} disabled={isImporting} className="w-full">
                  {isImporting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Đang nhập dữ liệu...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Xác nhận nhập ({validCount} dòng)
                    </>
                  )}
                </Button>
              )}
            </div>
          )}

          {/* Import result (after batch create) */}
          {importResult && (
            <div className="space-y-3">
              {importResult.message&&<p role="alert" className="text-sm text-destructive">{importResult.message}</p>}
              {importResult.pending&&importResult.canCorrect&&<p className="text-sm">Có thể sửa file tại các dòng bị từ chối rồi đọc lại. Các ID đã tạo chỉ được bỏ qua sau khi đối chiếu máy chủ; không tạo lại các dòng này.</p>}
              {importResult.customerIds.length>0&&<p className="text-xs text-muted-foreground">Khách đã tạo: {importResult.customerIds.map(item=>`dòng ${item.row}: ${item.id}`).join('; ')}.</p>}
              {importResult.failed === 0 ? (
                <Alert className="border-green-200 bg-green-50 text-green-800">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription>
                    Đã nhập thành công {importResult.success} hợp đồng
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    {importResult.success} thành công, {importResult.failed} thất bại
                  </AlertDescription>
                </Alert>
              )}

              {/* Import error table */}
              {importResult.createdIds.length > 0 && <p className="text-xs text-muted-foreground">
                Bản ghi đã tạo: {importResult.createdIds.map(item => `dòng ${item.row}: ${item.id}`).join('; ')}.
              </p>}
              {importResult.errors.length > 0 && (
                <div className="rounded-md border overflow-hidden max-h-48 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">Dòng</TableHead>
                        <TableHead>Lỗi</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {importResult.errors.map((err) => (
                        <TableRow key={err.row}>
                          <TableCell className="font-medium">{err.row}</TableCell>
                          <TableCell className="text-destructive text-sm">
                            {err.message}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <Button onClick={handleClose} variant="outline" className="w-full">
                Đóng
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
