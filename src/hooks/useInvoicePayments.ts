// =============================================
// Invoice Payments & Generation Hooks
// TanStack Query hooks for recording payments (RPC), auto-generating invoices (RPC),
// and importing invoices from Excel.
// Requirements: 2.4, 6.3, 7.1, 7.2
// =============================================

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { parseInvoiceExcel, validateParsedRows } from '@/lib/invoiceExcelHelpers';

// =============================================
// Types
// =============================================

export interface RecordPaymentRPCData {
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_date: string;
  notes?: string;
  receipt_image_url?: string;
  /** Sổ quỹ tiếp nhận khoản thu — required to mirror Resident's flow
   * (mỗi payment ⇒ 1 phiếu thu trong Thu chi). */
  account_id?: string | null;
  /** Tiền thối lại cho khách (chênh khách đưa vs còn phải thu). */
  change_amount?: number;
  /** Sổ quỹ ghi tiền thối — bắt buộc nếu change_amount > 0. */
  change_account_id?: string | null;
}

export interface AutoGenerateInvoicesRPCData {
  building_id: string;
  billing_month: string; // YYYY-MM
  invoice_type: 'rent_only' | 'service_only' | 'both';
}

export interface ImportInvoicesFromExcelData {
  file: File;
  buildingId: string;
  billingMonth: string; // YYYY-MM
}

export interface ImportInvoicesResult {
  created: number;
  errors: Array<{ row: number; message: string }>;
}

// =============================================
// useRecordPaymentRPC - Mutation calling RPC record_invoice_payment
// Requirements: 7.1, 7.2
// =============================================

export const useRecordPaymentRPC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: RecordPaymentRPCData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: result, error } = await (supabase.rpc as any)(
        'record_invoice_payment',
        {
          p_user_id: user.id,
          p_invoice_id: data.invoice_id,
          p_amount: data.amount,
          p_payment_method: data.payment_method,
          p_payment_date: data.payment_date,
          p_notes: data.notes ?? null,
          p_receipt_image_url: data.receipt_image_url ?? null,
        },
      );

      if (error) throw error;

      const newPaymentId = (result as any)?.payment_id ?? null;

      // ─────────────────────────────────────────────────────
      // Mirror Resident: every invoice payment ⇒ 1 phiếu thu
      // ─────────────────────────────────────────────────────
      // Fetch the invoice details we need to seed the voucher.
      const { data: inv } = await supabase
        .from('invoices')
        .select(
          'id, invoice_number, building_id, room_id, bed_id, contract_id, billing_month, tenant_id:contract_id'
        )
        .eq('id', data.invoice_id)
        .single() as any;

      const { data: incTypes, error: incTypesErr } = await supabase
        .from('income_expense_types' as any)
        .select('id, is_default, type, name')
        .eq('type', 'income')
        .limit(50) as any;
      if (incTypesErr) throw incTypesErr;
      const types = (incTypes ?? []) as Array<{ id: string; is_default?: boolean }>;
      const incomeTypeId = types.find((t) => t.is_default)?.id || types[0]?.id;

      if (inv && data.account_id) {
        if (!incomeTypeId) {
          throw new Error(
            'Chưa có loại thu nào trong "Loại thu/chi". Vào Cài đặt → Loại thu/chi để tạo trước.',
          );
        }

        const meta = (user.user_metadata ?? {}) as Record<string, any>;
        const creatorName: string =
          meta.full_name || meta.name || user.email || 'Người dùng';

        const { data: voucher, error: vErr } = await supabase
          .from('income_expenses' as any)
          .insert({
            user_id: user.id,
            type: 'INCOME',
            name: `Thu tiền theo hóa đơn ${inv.invoice_number || ''} - ${inv.billing_month || ''}`,
            building_id: inv.building_id,
            room_id: inv.room_id,
            bed_id: inv.bed_id,
            contract_id: inv.contract_id,
            account_id: data.account_id,
            invoice_id: inv.id,
            payment_id: newPaymentId,
            voucher_date: data.payment_date,
            payer_name: data.notes ?? null,
            notes: data.notes ?? null,
            attachments: data.receipt_image_url ? [data.receipt_image_url] : [],
            approval_status: 'APPROVED',
            creator_name: creatorName,
          } as any)
          .select()
          .single();

        if (vErr) throw vErr;

        const { error: itemErr } = await supabase
          .from('income_expense_items' as any)
          .insert({
            income_expense_id: (voucher as any).id,
            income_expense_type_id: incomeTypeId,
            description: `Thanh toán hoá đơn ${inv.invoice_number || ''}`,
            quantity: 1,
            unit_price: data.amount,
            start_date: data.payment_date,
            end_date: data.payment_date,
          });
        if (itemErr) throw itemErr;
      }
      // ─────────────────────────────────────────────────────

      // ─────────────────────────────────────────────────────
      // Tiền thối: tạo phiếu chi 'Tiền thối' vào sổ quỹ chỉ định
      // ─────────────────────────────────────────────────────
      if (inv && (data.change_amount ?? 0) > 0 && data.change_account_id) {
        const { data: refundType, error: refundTypeErr } = await supabase
          .from('income_expense_types' as any)
          .select('id')
          .eq('type', 'expense')
          .eq('name', 'Tiền thối')
          .limit(1)
          .maybeSingle() as any;
        if (refundTypeErr) throw refundTypeErr;
        if (!refundType?.id) {
          throw new Error('Chưa có loại chi "Tiền thối". Vào Cài đặt → Loại thu/chi để tạo trước.');
        }

        const meta = (user.user_metadata ?? {}) as Record<string, any>;
        const creatorName: string =
          meta.full_name || meta.name || user.email || 'Người dùng';

        const { data: refundVoucher, error: rvErr } = await supabase
          .from('income_expenses' as any)
          .insert({
            user_id: user.id,
            type: 'EXPENSE',
            name: `Tiền thối hoá đơn ${inv.invoice_number || ''} - ${inv.billing_month || ''}`,
            building_id: inv.building_id,
            room_id: inv.room_id,
            bed_id: inv.bed_id,
            contract_id: inv.contract_id,
            account_id: data.change_account_id,
            invoice_id: inv.id,
            voucher_date: data.payment_date,
            attachments: [],
            approval_status: 'APPROVED',
            creator_name: creatorName,
          } as any)
          .select()
          .single();
        if (rvErr) throw rvErr;

        const { error: refundItemErr } = await supabase
          .from('income_expense_items' as any)
          .insert({
            income_expense_id: (refundVoucher as any).id,
            income_expense_type_id: refundType.id,
            description: `Tiền thối hoá đơn ${inv.invoice_number || ''}`,
            quantity: 1,
            unit_price: data.change_amount,
            start_date: data.payment_date,
            end_date: data.payment_date,
          });
        if (refundItemErr) throw refundItemErr;
      }
      // ─────────────────────────────────────────────────────

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });
      queryClient.invalidateQueries({ queryKey: ['excess-amount'] });
      queryClient.invalidateQueries({ queryKey: ['income-expenses'] });
      queryClient.invalidateQueries({ queryKey: ['accounts-with-balance'] });

      toast({
        title: 'Thanh toán đã được ghi nhận thành công',
        description: 'Thanh toán đã được ghi nhận vào hệ thống.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi ghi nhận thanh toán',
        description: error.message,
      });
    },
  });
};


// =============================================
// useAutoGenerateInvoicesRPC - Mutation calling RPC generate_invoices_for_building
// Requirements: 6.3
// =============================================

export const useAutoGenerateInvoicesRPC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (data: AutoGenerateInvoicesRPCData) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { data: result, error } = await (supabase.rpc as any)(
        'generate_invoices_for_building',
        {
          p_user_id: user.id,
          p_building_id: data.building_id,
          p_billing_month: data.billing_month,
          p_invoice_type: data.invoice_type,
        },
      );

      if (error) throw error;
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      toast({
        title: 'Dữ liệu đã được TẠO thành công',
        description: 'Hoá đơn đã được sinh tự động cho toà nhà.',
      });
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi sinh hoá đơn',
        description: error.message,
      });
    },
  });
};

// =============================================
// useImportInvoicesFromExcel - Parse Excel → create multiple invoices
// Requirements: 2.4
// =============================================

export const useImportInvoicesFromExcel = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (
      data: ImportInvoicesFromExcelData,
    ): Promise<ImportInvoicesResult> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // 1. Parse Excel file
      const parsedRows = await parseInvoiceExcel(
        data.file,
        data.buildingId,
        data.billingMonth,
      );

      // 2. Validate parsed rows
      const { valid, errors } = validateParsedRows(parsedRows);

      // 3. Resolve room IDs for valid rows
      const { data: rooms, error: roomsError } = await supabase
        .from('rooms')
        .select('id, name')
        .eq('building_id', data.buildingId);

      if (roomsError) throw roomsError;

      const roomMap = new Map(
        (rooms || []).map((r: any) => [r.name, r.id]),
      );

      // 4. Resolve contracts for each room
      const { data: contracts, error: contractsError } = await supabase
        .from('contracts')
        .select('id, room_id')
        .eq('status', 'ACTIVE');

      if (contractsError) throw contractsError;

      const contractByRoom = new Map(
        (contracts || []).map((c: any) => [c.room_id, c.id]),
      );

      // 5. Resolve services by name
      const { data: services, error: servicesError } = await supabase
        .from('services')
        .select('id, name, price')
        ;

      if (servicesError) throw servicesError;

      const serviceMap = new Map(
        (services || []).map((s: any) => [s.name, { id: s.id, price: s.price }]),
      );

      // 6. Create invoices for each valid row
      let created = 0;
      const importErrors = [...errors];

      const { generateInvoiceNumber } = await import('@/lib/invoiceUtils');

      for (let i = 0; i < valid.length; i++) {
        const row = valid[i];
        const rowNumber = i + 2; // +2 for header row offset

        const roomId = roomMap.get(row.room_name);
        if (!roomId) {
          importErrors.push({
            row: rowNumber,
            message: `Phòng '${row.room_name}' không tồn tại trong toà nhà`,
          });
          continue;
        }

        const contractId = contractByRoom.get(roomId);
        if (!contractId) {
          importErrors.push({
            row: rowNumber,
            message: `Không tìm thấy hợp đồng hiệu lực cho phòng '${row.room_name}'`,
          });
          continue;
        }

        try {
          // Build invoice items from services
          const items: Array<{
            service_id: string | null;
            type: string;
            description: string;
            unit_price: number;
            quantity: number;
            coefficient: number;
            amount: number;
            sort_order: number;
          }> = [];

          let sortOrder = 0;
          for (const [serviceName, amount] of Object.entries(row.services)) {
            const serviceInfo = serviceMap.get(serviceName);
            items.push({
              service_id: serviceInfo?.id ?? null,
              type: 'SERVICE',
              description: serviceName,
              unit_price: serviceInfo?.price ?? amount,
              quantity: serviceInfo?.price ? amount / serviceInfo.price : 1,
              coefficient: 1,
              amount,
              sort_order: sortOrder++,
            });
          }

          const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
          const invoiceNumber = await generateInvoiceNumber(user.id);

          // Insert invoice
          const { data: invoice, error: invoiceError } = await supabase
            .from('invoices')
            .insert({
              user_id: user.id,
              contract_id: contractId,
              building_id: data.buildingId,
              room_id: roomId,
              invoice_number: invoiceNumber,
              billing_month: data.billingMonth,
              issue_date: new Date().toISOString().split('T')[0],
              due_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
                .toISOString()
                .split('T')[0],
              status: 'DRAFT' as any,
              subtotal,
              discount_amount: 0,
              tax_percent: 0,
              tax_amount: 0,
              total_amount: subtotal,
              prepaid_amount: 0,
              paid_amount: 0,
              previous_debt: 0,
            } as any)
            .select()
            .single();

          if (invoiceError) throw invoiceError;

          // Insert invoice items
          if (items.length > 0) {
            const invoiceItems = items.map((item) => ({
              invoice_id: invoice.id,
              ...item,
            }));

            const { error: itemsError } = await supabase
              .from('invoice_items')
              .insert(invoiceItems as any);

            if (itemsError) throw itemsError;
          }

          created++;
        } catch (err: any) {
          importErrors.push({
            row: rowNumber,
            message: err.message || 'Lỗi không xác định khi tạo hoá đơn',
          });
        }
      }

      return { created, errors: importErrors };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['invoice-statistics'] });

      if (result.created > 0) {
        toast({
          title: 'Dữ liệu đã được TẠO thành công',
          description: `Đã tạo ${result.created} hoá đơn từ file Excel.${
            result.errors.length > 0
              ? ` ${result.errors.length} dòng bị lỗi.`
              : ''
          }`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Không tạo được hoá đơn nào',
          description: `${result.errors.length} dòng bị lỗi. Vui lòng kiểm tra lại file Excel.`,
        });
      }
    },
    onError: (error: Error) => {
      toast({
        variant: 'destructive',
        title: 'Có lỗi xảy ra khi nhập hoá đơn từ Excel',
        description: error.message,
      });
    },
  });
};
