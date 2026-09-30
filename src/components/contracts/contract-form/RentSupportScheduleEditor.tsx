import type { UseFormReturn } from 'react-hook-form';
import type { ContractFormData } from '@/lib/contractValidation';
import { buildCustomerSupportMonths, supportCustomerScheduleSchema, type SupportCustomerSchedule, type SupportPlanInput } from '@/lib/rentSupport';
import type { SupportParty } from '@/lib/rentSupportFunding';
import { computeFirstBillingMonth } from '@/lib/firstInvoiceBuilder';
import { CurrencyInput } from '@/components/ui/currency-input';
import { NumberInput } from '@/components/ui/number-input';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatVND } from '@/lib/utils';

export interface RentSupportScheduleEditorProps {
  form: UseFormReturn<ContractFormData>;
  parties: SupportParty[];
  readonlySchedule?: SupportCustomerSchedule;
  disabled?: boolean;
  partyLoading?: boolean;
  partyError?: string;
  onSelectParty?: (party: SupportParty) => Promise<string>;
  canEditFunding?: boolean;
}
const labelMonth = (month: string) => `${month.slice(5)}/${month.slice(0, 4)}`;
export function RentSupportScheduleEditor({ form, parties, readonlySchedule, disabled, partyLoading, partyError, onSelectParty, canEditFunding = true }: RentSupportScheduleEditorProps) {
  const values = form.watch();
  const start = values.start_billing_date || values.start_date || '';
  const end = values.end_billing_date || '';
  const existing = values.rent_support;
  const plan: SupportPlanInput = existing ?? { version: 2, start_billing_month: start.slice(0, 7), payer: 'BUILDING', sale_party_id: null,
    deduction_policy: 'COMMISSION_ONLY', collection_mode: 'UPFRONT_COMMITTED', segments: [{ month_count: 1, monthly_amount: '0' }] };
  const schedule = readonlySchedule ?? plan;
  const firstMonth = start && end ? computeFirstBillingMonth(start, end) : '';
  const readOnly = disabled || !!readonlySchedule;
  const update = (patch: Partial<SupportPlanInput>) => {
    form.setValue('rent_support', { ...plan, ...patch }, { shouldDirty: true, shouldValidate: true });
    form.setValue('discount_months', 0, { shouldDirty: true });
    form.setValue('discount_amount_per_month', 0, { shouldDirty: true });
  };
  let months: ReturnType<typeof buildCustomerSupportMonths> = [];
  let scheduleError = '';
  if (firstMonth || readonlySchedule) {
    try {
      const parsed = supportCustomerScheduleSchema.parse({ version: 2, start_billing_month: schedule.start_billing_month, segments: schedule.segments });
      months = buildCustomerSupportMonths(parsed, { ...(values.start_date ? { contract_start_date: values.start_date } : {}),
        ...(values.end_date ? { contract_end_date: values.end_date } : {}),
        invoice_periods: firstMonth ? [{ billing_month: firstMonth, invoice_period_label: `${start} – ${end}`, eligible_revenue: String(values.rent_price ?? 0) }] : [] });
    } catch { scheduleError = 'Kiểm tra tháng bắt đầu, số tháng và thời hạn hợp đồng của lịch hỗ trợ.'; }
  }
  const total = months.reduce((sum, month) => sum + Number(month.agreed_amount), 0);
  let offset = 0;
  return <section className="space-y-3 rounded-md border p-3" aria-label="Lịch hỗ trợ tiền thuê">
    <h4 className="text-sm font-semibold">Lịch hỗ trợ tiền thuê</h4>
    {readonlySchedule && <p className="text-sm">Chỉ xem lịch khách hưởng. Cấu hình tài chính cần quyền riêng.</p>}
    <fieldset disabled={readOnly} className="space-y-3">
      <label className="block text-sm">Tháng bắt đầu hỗ trợ<Input aria-label="Tháng bắt đầu hỗ trợ" type="month" value={schedule.start_billing_month} onChange={event => update({ start_billing_month: event.target.value })}/></label>
      {schedule.segments.map((segment, index) => {
        const segmentMonths = months.slice(offset, offset + segment.month_count); offset += segment.month_count;
        return <div key={index} className="space-y-2 rounded border p-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">Số tháng giai đoạn {index + 1}<NumberInput aria-label={`Số tháng giai đoạn ${index + 1}`} min={1} value={segment.month_count} onChange={count => update({ segments: plan.segments.map((row, i) => i === index ? { ...row, month_count: count } : row) })}/></label>
            <label className="text-sm">Hỗ trợ mỗi tháng giai đoạn {index + 1}<CurrencyInput aria-label={`Hỗ trợ mỗi tháng giai đoạn ${index + 1}`} value={Number(segment.monthly_amount)} onChange={amount => update({ segments: plan.segments.map((row, i) => i === index ? { ...row, monthly_amount: String(amount ?? 0) } : row) })}/></label>
          </div>
          {segmentMonths.length > 0 && <p className="text-xs">{segmentMonths.map(row => labelMonth(row.billing_month)).join(' · ')}</p>}
          {index > 0 && <Button type="button" variant="ghost" onClick={() => update({ segments: plan.segments.filter((_, i) => i !== index) })}>Xóa giai đoạn {index + 1}</Button>}
        </div>;
      })}
      {!readonlySchedule && <Button type="button" variant="outline" onClick={() => update({ segments: [...plan.segments, { month_count: 1, monthly_amount: '0' }] })}>Thêm giai đoạn kế tiếp</Button>}
      {!readonlySchedule && canEditFunding && <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">Người chịu hỗ trợ<select aria-label="Người chịu hỗ trợ" className="block w-full rounded border p-2" value={plan.payer} onChange={event => update({ payer: event.target.value as SupportPlanInput['payer'], sale_party_id: null })}><option value="BUILDING">Toà chịu</option><option value="SALE">Sale chịu</option></select></label>
        {plan.payer === 'SALE' && <>
          <label className="text-sm">Nguồn khấu trừ<select aria-label="Nguồn khấu trừ" className="block w-full rounded border p-2" value={plan.deduction_policy} onChange={event => update({ deduction_policy: event.target.value as SupportPlanInput['deduction_policy'] })}><option value="COMMISSION_ONLY">Chỉ hoa hồng</option><option value="BONUS_THEN_COMMISSION">Thưởng trước, phần thiếu chuyển sang hoa hồng</option></select></label>
          <label className="text-sm">Sale chịu hỗ trợ<select aria-label="Sale chịu hỗ trợ" className="block w-full rounded border p-2" disabled={partyLoading || !!partyError} value={plan.sale_party_id ?? ''} onChange={async event => {
            const party = parties.find(row => (row.party_id ?? row.profile_id) === event.target.value);
            if (!party) { update({ sale_party_id: null }); return; }
            // Candidates must be explicitly registered; a profile UUID is never saved as a party UUID.
            const id = party.party_id ?? await onSelectParty?.(party); if (id) update({ sale_party_id: id });
          }}><option value="">Chọn danh tính đã xác minh</option>{parties.map(party => <option key={party.party_id ?? party.profile_id ?? party.display_name} value={party.party_id ?? party.profile_id ?? ''}>{party.display_name}{party.party_id ? '' : ' · đăng ký khi chọn'}</option>)}</select></label>
          {!plan.sale_party_id && <p className="text-sm text-destructive">Chọn và xác minh danh tính Sale trước khi lưu.</p>}
          {partyError && <p role="alert" className="text-sm text-destructive">{partyError}</p>}
        </>}
      </div>}
      {!readonlySchedule && canEditFunding && plan.payer === 'BUILDING' && <p className="text-sm">Toà chịu hỗ trợ; giữ lịch khách hưởng, không khấu trừ hoa hồng hoặc thưởng Sale.</p>}
      {!readonlySchedule && !canEditFunding && <p className="text-sm">Cần quyền tài chính để cấu hình và lưu lịch hỗ trợ.</p>}
      {existing && !readonlySchedule && <Button type="button" variant="ghost" onClick={() => form.setValue('rent_support', undefined, { shouldDirty: true, shouldValidate: true })}>Bỏ lịch hỗ trợ</Button>}
    </fieldset>
    {!firstMonth && !readonlySchedule && <p className="text-sm">Nhập ngày bắt đầu tính tiền và ngày kết thúc kỳ đầu để xem tháng/kỳ hỗ trợ.</p>}
    {scheduleError && <p role="alert" className="text-sm text-destructive">{scheduleError}</p>}
    {months.length > 0 && <>
      <p className="font-medium text-sm">Tổng hỗ trợ khách: {formatVND(total)}</p>
      {firstMonth && <p className="text-xs">Kỳ đầu dự kiến: {labelMonth(firstMonth)} · {start} – {end}</p>}
      <table className="w-full text-xs"><thead><tr><th className="text-left">Tháng khách hưởng</th><th className="text-right">Mức hỗ trợ</th><th className="text-left pl-3">Kỳ hóa đơn</th></tr></thead><tbody>{months.map(month => <tr key={month.billing_month}><td>{labelMonth(month.billing_month)}</td><td className="text-right">{formatVND(Number(month.agreed_amount))}</td><td className="pl-3">{month.eligibility === 'UNMAPPED' ? `${labelMonth(month.billing_month)} chưa có kỳ hóa đơn đủ điều kiện` : month.eligibility === 'PLANNED' ? `${labelMonth(month.billing_month)} · dự kiến, chưa lập hóa đơn` : month.eligibility === 'REVENUE_CAP_REVIEW' ? 'Hỗ trợ vượt doanh thu; cần đối chiếu' : `${month.invoice_period_label} · dự kiến`}</td></tr>)}</tbody></table>
      {!readonlySchedule && <p className="text-xs text-muted-foreground">Bảng này xem trước lịch khách. Trước khi tạo phiếu phải kiểm tra lại nguồn chi và quote máy chủ; tính năng ghi hỗ trợ chưa được bật.</p>}
    </>}
  </section>;
}
