/**
 * ContractImportExportDialog
 * Dialog for importing contracts from Excel and exporting contract list.
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2
 */

import { useRef, useState, useMemo } from 'react';
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
import { getSessionUser } from "@/lib/authSession";

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
  const [importResult, setImportResult] = useState<{ success: number; failed: number; errors: Array<{ row: number; message: string }> } | null>(null);

  const { data: buildingsData } = useBuildings();
  const buildings = useMemo(
    () => (Array.isArray(buildingsData) ? buildingsData : []) as BuildingWithRelations[],
    [buildingsData]
  );

  // ---- handlers ----

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setParseResult(null);
    setParseError(null);
    setImportResult(null);
  }

  function handleSelectFile() {
    fileInputRef.current?.click();
  }

  async function handleParse() {
    if (!selectedFile || !selectedBuildingId) return;
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
    if (!parseResult || !selectedBuildingId) return;
    const validRows = parseResult.success;
    if (validRows.length === 0) return;

    setIsImporting(true);
    const results = { success: 0, failed: 0, errors: [] as Array<{ row: number; message: string }> };

    // Get user
    const user = await getSessionUser();
    if (!user) {
      toast.error('Chưa đăng nhập');
      setIsImporting(false);
      return;
    }

    // Load rooms for the selected building
    const { data: rooms } = await supabase
      .from('rooms')
      .select('id, name, code')
      .eq('building_id', selectedBuildingId)
      .is('deleted_at', null);

    // Load existing customers
    const { data: existingCustomers } = await supabase
      .from('customers')
      .select('id, full_name, phone, id_number')
      .is('deleted_at', null);

    const customersList: Array<{ id: string; full_name: string; phone: string; id_number: string | null }> = existingCustomers ?? [];

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      const rowNum = i + 2;

      try {
        // Find room by name
        const room = rooms?.find(
          (r: any) =>
            r.name?.toLowerCase() === row.room_name.toLowerCase() ||
            r.code?.toLowerCase() === row.room_name.toLowerCase()
        );
        if (!room) {
          results.errors.push({ row: rowNum, message: `Không tìm thấy phòng "${row.room_name}"` });
          results.failed++;
          continue;
        }

        // Find or create customer
        let customerId: string;
        const existingCustomer = customersList.find(
          (c: any) => c.phone === row.customer_phone
        );

        if (existingCustomer) {
          customerId = existingCustomer.id;
        } else {
          const { data: newCustomer, error: customerError } = await supabase
            .from('customers')
            .insert({
              user_id: user.id,
              full_name: row.customer_name,
              phone: row.customer_phone,
              id_number: row.customer_id_number || null,
            })
            .select()
            .single();

          if (customerError || !newCustomer) {
            results.errors.push({ row: rowNum, message: `Không thể tạo khách hàng: ${customerError?.message || 'Unknown'}` });
            results.failed++;
            continue;
          }
          customerId = newCustomer.id;
          customersList.push({ id: newCustomer.id, full_name: row.customer_name, phone: row.customer_phone, id_number: row.customer_id_number || null });
        }

        // Create contract using direct insert (batch-friendly)
        const contractInsert: any = {
          user_id: user.id,
          tenant_id: customerId,
          room_id: room.id,
          signed_date: row.signed_date,
          start_date: row.start_date,
          end_date: row.end_date,
          rent_price: row.rent_price,
          payment_cycle: row.payment_cycle || 'MONTHLY',
          total_deposit: row.deposit || 0,
          deposit_paid: 0,
          notes: row.notes || null,
          status: 'ACTIVE',
        };

        const { data: contract, error: contractError } = await supabase
          .from('contracts')
          .insert(contractInsert)
          .select()
          .single();

        if (contractError || !contract) {
          results.errors.push({ row: rowNum, message: `Lỗi tạo hợp đồng: ${contractError?.message || 'Unknown'}` });
          results.failed++;
          continue;
        }

        // Insert contract_customer
        await supabase.from('contract_customers').insert({
          contract_id: contract.id,
          customer_id: customerId,
          is_representative: true,
        });

        // Update room status
        await supabase
          .from('rooms')
          .update({ status: 'OCCUPIED' })
          .eq('id', room.id);

        results.success++;
      } catch (e: any) {
        results.errors.push({ row: rowNum, message: e.message || 'Lỗi không xác định' });
        results.failed++;
      }
    }

    setImportResult(results);
    setIsImporting(false);

    if (results.success > 0) {
      toast.success(`Đã tạo ${results.success} hợp đồng.${results.failed > 0 ? ` ${results.failed} thất bại.` : ''}`);
    } else if (results.failed > 0) {
      toast.error(`Tất cả ${results.failed} hợp đồng đều gặp lỗi.`);
    }
  }

  function handleExport() {
    if (!contracts) return;
    exportContracts(contracts, currentFilters);
    handleClose();
  }

  function handleClose() {
    onOpenChange(false);
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
  const canParse = !!selectedFile && !!selectedBuildingId && !isParsing;
  const canConfirm = hasParseResult && validCount > 0 && !isImporting && !importResult;

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
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nhập dữ liệu hợp đồng</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step 1: Select building */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Bước 1: Chọn toà nhà</p>
            <Select value={selectedBuildingId} onValueChange={setSelectedBuildingId}>
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
