import { useEffect, useMemo, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUpdateInvoice, useExcessAmount, useInvoice } from '@/hooks/useInvoices';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import type {
  InvoiceFormData,
  InvoiceWithRelations,
  PreviousDebtSource,
} from '@/types/invoice';
import { getInvoiceEditMode } from '@/lib/invoiceUtils';
import { computePreviousDebt } from '@/lib/invoiceHelpers';
import {
  buildInvoiceItems,
  decomposeInvoice,
  findDepositIndex,
  firstEntryError,
  invoiceEntrySchema,
  resolveBuildingDefaults,
  type BuildingServiceRow,
  type InvoiceEntryValues,
} from '@/lib/invoiceEntry';
import { useBuildingServices } from '@/hooks/useBuildingServices';
import { supabase } from '@/integrations/supabase/client';
import { InvoiceEntryShell } from './invoice-entry/InvoiceEntryShell';
import { useInvoiceEntry } from './invoice-entry/useInvoiceEntry';
import type { InvoiceEntryCurrent, InvoiceEntryPricing } from './invoice-entry/types';

import IssuedInvoiceEditor from './IssuedInvoiceEditor';

interface EditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: InvoiceWithRelations;
}

function representativeName(invoice: InvoiceWithRelations): string {
  const ccs = invoice.contract?.contract_customers ?? [];
  const rep = ccs.find((c) => c.is_representative) ?? ccs[0];
  return rep?.customer?.full_name ?? invoice.tenant?.full_name ?? '';
}

function initialDebtSources(invoice: InvoiceWithRelations): PreviousDebtSource[] {
  return Array.isArray(invoice.previous_debt_sources)
    ? (invoice.previous_debt_sources as PreviousDebtSource[])
    : [];
}

/**
 * Sửa hoá đơn NHÁP — dùng bộ nhập liệu chung với luồng tạo lẻ. Toà/phòng/hợp
 * đồng và nguồn nợ giữ cố định; số tiền đã lưu chỉ đổi ở ô người dùng đụng vào.
 */
const DraftInvoiceEditor = ({ open, onOpenChange, invoice }: EditInvoiceDialogProps) => {
  const updateMutation = useUpdateInvoice();
  const [meterId, setMeterId] = useState<string | null>(null);
  const [debtSources, setDebtSources] = useState<PreviousDebtSource[]>(() => initialDebtSources(invoice));
  const [isLoadingDebt, setIsLoadingDebt] = useState(false);

  const decomposed = useMemo(() => decomposeInvoice(invoice), [invoice]);

  const form = useForm<InvoiceEntryValues>({
    resolver: zodResolver(invoiceEntrySchema) as Resolver<InvoiceEntryValues>,
    defaultValues: decomposed.values,
  });
  const { handleSubmit, reset, setValue, formState: { errors } } = form;

  // Reset when invoice prop changes
  useEffect(() => {
    reset(decomposeInvoice(invoice).values);
    // Sources gốc của HĐ — giữ nguyên nếu user không bấm "tính lại"/chỉnh tay,
    // để lần sửa HĐ KHÔNG âm thầm xoá link cascade tất toán HĐ cũ.
    setDebtSources(initialDebtSources(invoice));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  // Tính lại nợ cũ từ các HĐ cũ chưa tất toán (loại chính HĐ đang sửa).
  const handleReloadPreviousDebt = async () => {
    if (!invoice.contract_id) return;
    setIsLoadingDebt(true);
    try {
      const { total, sources } = await computePreviousDebt(invoice.contract_id, {
        excludeInvoiceId: invoice.id,
      });
      setValue('previous_debt', total, { shouldDirty: true });
      setValue('previous_debt_overridden', false);
      setDebtSources(sources);
    } finally {
      setIsLoadingDebt(false);
    }
  };

  const { data: bldSvc } = useBuildingServices(invoice.building_id);
  const defaults = useMemo(
    () => resolveBuildingDefaults(bldSvc as BuildingServiceRow[] | undefined),
    [bldSvc],
  );
  const pricing: InvoiceEntryPricing = useMemo(
    () => ({ ...defaults, waterApplicable: true, pdvApplicable: true, hasContractServices: false }),
    [defaults],
  );

  // Load meter for room (chỉ số đầu)
  useEffect(() => {
    if (!invoice.room_id) {
      setMeterId(null);
      return;
    }
    (async () => {
      const { data: meters } = await supabase
        .from('meters')
        .select('id')
        .eq('room_id', invoice.room_id)
        .eq('meter_type', 'ELECTRICITY')
        .is('deleted_at', null)
        .limit(1);
      setMeterId((meters as Array<{ id: string }> | null)?.[0]?.id ?? null);
    })();
  }, [invoice.room_id]);

  const ctl = useInvoiceEntry(form, { baseline: decomposed.values, baselineAmounts: decomposed.baseline, pricing });
  const { data: creditBalance = 0 } = useExcessAmount(invoice.contract_id);

  const current: InvoiceEntryCurrent = useMemo(() => {
    const { values: b, baseline } = decomposed;
    const depIdx = findDepositIndex(b.custom_items);
    const dep = depIdx >= 0 ? b.custom_items[depIdx] : null;
    return {
      rentPrice: b.rent_price,
      rentAmount: baseline.rentAmount,
      deposit: dep ? dep.unit_price * dep.quantity : 0,
      electric: b.electric_amount,
      prev: b.prev_reading,
      curr: b.current_reading,
      occupants: b.occupants,
      water: baseline.waterAmount,
      pdv: baseline.pdvAmount,
      total: Number(invoice.total_amount) || 0,
    };
  }, [decomposed, invoice.total_amount]);

  const onSubmit = (data: InvoiceEntryValues) => {
    const items = buildInvoiceItems(data, {
      elecServiceId: defaults.elecServiceId,
      waterServiceId: defaults.waterServiceId,
      pdvServiceId: defaults.pdvServiceId,
      rentDescription: decomposed.rentDescription,
      baseline: decomposed.baseline,
    });

    const formData: InvoiceFormData = {
      building_id: invoice.building_id,
      room_id: invoice.room_id,
      contract_id: invoice.contract_id,
      billing_month: data.billing_month,
      issue_date: data.issue_date,
      due_date: data.due_date,
      notes: data.notes || null,
      discount_amount: data.discount_amount || 0,
      discount_notes: data.discount_notes?.trim() || null,
      applied_credit: 0,
      electricity_prev_overridden: !!data.prev_reading_overridden,
      prepaid_amount: invoice.prepaid_amount || 0,
      previous_debt: data.previous_debt || 0,
      // User chỉnh tay → clear sources để DB trigger KHÔNG cascade-paid sai
      // (amount không còn khớp tổng sources). Cùng quy ước với flow tạo HĐ.
      previous_debt_sources: data.previous_debt_overridden ? [] : debtSources,
      items,
    };

    updateMutation.mutate(
      { id: invoice.id, formData },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <InvoiceEntryShell
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit(onSubmit)}
      mode="edit"
      ctl={ctl}
      header={{
        title: 'Sửa hoá đơn',
        invoiceNo: invoice.invoice_number || invoice.id.slice(0, 8),
        building: invoice.building?.name ?? '',
        room: invoice.room?.name ?? '',
        rep: representativeName(invoice),
        lockNote: 'Toà/phòng · hợp đồng · nguồn nợ giữ cố định để bảo toàn liên kết chứng từ.',
      }}
      current={current}
      pricing={pricing}
      meterId={meterId}
      debt={{
        sources: debtSources,
        loading: isLoadingDebt,
        canReload: !!invoice.contract_id,
        onReload: handleReloadPreviousDebt,
      }}
      creditBalance={creditBalance}
      defaultDepositAmount={0}
      ready
      validationError={firstEntryError(errors)}
      onResetAll={() => reset(decomposed.values)}
      onCancel={() => onOpenChange(false)}
      footNote="Hoá đơn nháp — lưu sẽ thay toàn bộ dòng bằng giá trị mới."
      submit={{
        label: 'Lưu hoá đơn',
        pendingLabel: 'Đang lưu...',
        pending: updateMutation.isPending,
        disabled: false,
      }}
    />
  );
};

const OpenIssuedInvoiceEditor = ({ invoice, onOpenChange }: EditInvoiceDialogProps) => {
  const { refetch } = useInvoice(invoice.id);
  const [loadedInvoice, setLoadedInvoice] = useState<InvoiceWithRelations | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    // A collection can finish before its cache invalidation finishes. Capture
    // fields and concurrency tokens together only after this opening's read.
    void refetch({ cancelRefetch: true }).then(result => {
      if (!active) return;
      if (result.isError || !result.data) {
        setLoadError('Không tải được hóa đơn mới nhất. Vui lòng thử lại.');
      } else if (getInvoiceEditMode(result.data) !== 'adjustment') {
        setLoadError('Hóa đơn không còn cho phép điều chỉnh.');
      } else {
        setLoadedInvoice(result.data);
      }
    });
    return () => { active = false; };
  }, [refetch, attempt]);

  if (loadedInvoice) return <IssuedInvoiceEditor invoice={loadedInvoice} onOpenChange={onOpenChange} />;
  return <Dialog open onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Điều chỉnh hóa đơn</DialogTitle>
        <DialogDescription>{loadError ?? 'Đang tải hóa đơn mới nhất...'}</DialogDescription>
      </DialogHeader>
      {loadError && <Button onClick={() => { setLoadError(null); setAttempt(value => value + 1); }}>Thử tải lại</Button>}
    </DialogContent>
  </Dialog>;
};

const AuthorizedIssuedInvoiceEditor = (props: EditInvoiceDialogProps) => {
  const { data: permissions } = useMyPermissions();
  if (canUse(permissions, 'invoices', 'edit')) return <OpenIssuedInvoiceEditor {...props} />;
  return <Dialog open onOpenChange={props.onOpenChange}><DialogContent><DialogHeader>
    <DialogTitle>Không thể sửa hóa đơn</DialogTitle>
    <DialogDescription>Chưa xác nhận được quyền chỉnh sửa hóa đơn.</DialogDescription>
  </DialogHeader></DialogContent></Dialog>;
};

const EditInvoiceDialog = (props: EditInvoiceDialogProps) => {
  if (!props.open) return null;
  const mode = getInvoiceEditMode(props.invoice);
  if (mode === 'adjustment') return <AuthorizedIssuedInvoiceEditor key={props.invoice.id} {...props} />;
  if (mode === 'draft') return <DraftInvoiceEditor key={props.invoice.id} {...props} />;
  return <Dialog open onOpenChange={props.onOpenChange}><DialogContent><DialogHeader><DialogTitle>Không thể sửa hóa đơn</DialogTitle><DialogDescription>Hóa đơn đã hủy hoặc không còn cho phép chỉnh sửa. Tải lại để kiểm tra trạng thái.</DialogDescription></DialogHeader></DialogContent></Dialog>;
};
export default EditInvoiceDialog;
