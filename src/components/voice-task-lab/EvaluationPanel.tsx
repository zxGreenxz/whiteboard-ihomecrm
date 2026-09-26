import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, CheckCircle2, ClipboardCheck, Loader2, Minus, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { createReview, displayValue, editExpected, fieldLabels, reviewFormSchema, scoredFields, type Prediction, type ReviewForm } from '@/lib/voice-task-lab/model';

type Props = { deviceStorage?: boolean; prediction: Prediction; busy: boolean; saving: boolean; stale: boolean; saved: boolean; onSave: (values: ReviewForm) => void; onNew: () => void };
const options = [
  { value: 'correct' as const, label: 'Đúng', Icon: Check, selected: 'border-teal-700 bg-teal-700 text-white' },
  { value: 'incorrect' as const, label: 'Sai', Icon: X, selected: 'border-rose-600 bg-rose-50 text-rose-700' },
  { value: 'not_applicable' as const, label: 'Không áp dụng', Icon: Minus, selected: 'border-slate-500 bg-slate-100 text-slate-800' },
];

export function EvaluationPanel({ deviceStorage = false, prediction, busy, saving, stale, saved, onSave, onNew }: Props) {
  const initial = createReview(prediction.predicted);
  const form = useForm<ReviewForm>({ resolver: zodResolver(reviewFormSchema), defaultValues: { expected: initial.expected, verdicts: initial.verdicts, notes: '' } });
  const verdicts = form.watch('verdicts');
  const usefulness = form.watch('usefulness');
  const reviewed = scoredFields.filter(field => verdicts[field] !== 'unreviewed').length;
  const frozen = busy || saved;
  return <form onSubmit={form.handleSubmit(onSave)} className="space-y-5" aria-label="Đánh giá bản dự đoán">
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Bước 03 / Đánh giá</p><h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">AI hiểu đúng bao nhiêu?</h2></div>
      <span className="shrink-0 rounded-full bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-800">{reviewed}/7 trường</span>
    </div>
    <p className="text-sm leading-6 text-slate-600">Đối chiếu với ý định ban đầu của bạn. Chưa chọn sẽ được ghi là <strong className="font-medium text-slate-800">chưa đánh giá</strong>, không tính là đúng.</p>
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {scoredFields.map((field, index) => <fieldset key={field} className={cn('min-w-0 p-4 sm:p-5', index > 0 && 'border-t border-slate-100')} disabled={frozen}>
        <legend className="sr-only">{fieldLabels[field]}</legend>
        <div className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold text-slate-500">{index + 1}</span><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{fieldLabels[field]}</span>{verdicts[field] === 'unreviewed' && <span className="ml-auto text-[11px] text-slate-400">Chưa chấm</span>}</div>
        <p className="mb-3 mt-2 break-words text-base font-medium text-slate-900">{displayValue(field, prediction.predicted[field])}</p>
        <div className="grid grid-cols-[1fr_1fr_1.55fr] gap-1.5" role="radiogroup" aria-label={`Độ đúng của ${fieldLabels[field]}`}>
          {options.map(({ value, label, Icon, selected }) => <label key={value} className={cn('relative flex min-h-11 cursor-pointer items-center justify-center gap-1 rounded-xl border px-1 py-2 text-xs font-medium transition-colors sm:text-sm', verdicts[field] === value ? selected : 'border-slate-200 text-slate-600 hover:bg-slate-50', frozen && 'cursor-default opacity-70', 'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-teal-500 has-[:focus-visible]:ring-offset-2')}>
            <input type="radio" className="sr-only" name={`verdict-${field}`} value={value} checked={verdicts[field] === value} onChange={() => {
              if (value === 'correct') form.setValue(`expected.${field}`, prediction.predicted[field], { shouldDirty: true, shouldValidate: true });
              form.setValue(`verdicts.${field}`, value, { shouldDirty: true });
            }} /><Icon className="size-3.5 shrink-0" />{label}
          </label>)}
        </div>
        {verdicts[field] === 'incorrect' && <div className="mt-3 rounded-xl bg-rose-50/70 p-3"><label htmlFor={`expected-${field}`} className="text-xs font-medium text-rose-900">Giá trị bạn mong đợi{field === 'deadline' && ' (giờ Việt Nam)'}</label>{field === 'priority' ? <select id={`expected-${field}`} className="mt-2 h-11 w-full rounded-md border border-rose-200 bg-white px-3 text-base" {...form.register('expected.priority')}><option value="NORMAL">Bình thường</option><option value="LOW">Thấp</option><option value="URGENT">Gấp</option></select> : field === 'deadline' ? <Input id={`expected-${field}`} type="datetime-local" className="mt-2 h-11 min-w-0 border-rose-200 bg-white text-base" value={form.watch('expected.deadline').slice(0, 16)} onChange={event => form.setValue('expected.deadline', event.target.value ? `${event.target.value}:00+07:00` : '', { shouldDirty: true, shouldValidate: true })} /> : <Input id={`expected-${field}`} className="mt-2 h-11 border-rose-200 bg-white text-base" {...form.register(`expected.${field}`)} onChange={event => {
          const next = editExpected({ predicted: prediction.predicted, expected: form.getValues('expected'), verdicts: form.getValues('verdicts') }, field, event.target.value);
          form.setValue(`expected.${field}`, next.expected[field], { shouldDirty: true });
          form.setValue(`verdicts.${field}`, next.verdicts[field]);
        }} />}{form.formState.errors.expected?.[field] && <p role="alert" className="mt-2 text-xs text-rose-800">{form.formState.errors.expected[field]?.message}</p>}<p className="mt-1.5 text-[11px] leading-4 text-rose-700">Bản AI dự đoán phía trên được giữ nguyên để đối chiếu.</p></div>}
      </fieldset>)}
    </div>
    <fieldset disabled={frozen} className="rounded-2xl border border-slate-200 bg-white p-5">
      <legend className="sr-only">Mức hữu ích</legend>
      <div className="flex items-center gap-2 text-base font-semibold text-slate-900"><ClipboardCheck className="size-5 text-teal-700" />Bản nháp này hữu ích không?</div>
      <p className="mb-4 mt-1 text-sm leading-6 text-slate-500">Chọn một mức để lưu lượt đánh giá.</p>
      <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Mức hữu ích từ 1 đến 5">
        {[1, 2, 3, 4, 5].map(value => <label key={value} className={cn('relative flex h-12 cursor-pointer items-center justify-center rounded-xl border text-lg font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-teal-500 has-[:focus-visible]:ring-offset-2', usefulness === value ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-200 bg-slate-50/50 text-slate-600')}><input type="radio" className="sr-only" name="usefulness" aria-label={`${value} trên 5`} checked={usefulness === value} onChange={() => form.setValue('usefulness', value, { shouldValidate: true })} />{value}</label>)}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-slate-500"><span>1 · Chưa dùng được</span><span>5 · Dùng ngay</span></div>
      {form.formState.errors.usefulness && <p role="alert" className="mt-3 text-sm text-rose-700">Chọn mức hữu ích từ 1 đến 5.</p>}
      <label htmlFor="review-notes" className="mb-2 mt-5 block text-sm font-medium text-slate-700">Góp ý thêm <span className="font-normal text-slate-400">(không bắt buộc)</span></label>
      <Textarea id="review-notes" className="min-h-24 rounded-xl text-base" placeholder="AI nghe sai từ nào, thiếu điều gì…" maxLength={4000} {...form.register('notes')} />
    </fieldset>
    {stale && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">Lời nói đã thay đổi. Quay lại bước Ghi âm và phân tích lại trước khi lưu đánh giá.</p>}
    {saved ? <div className="rounded-2xl border border-teal-200 bg-teal-50 p-5"><p className="flex items-center gap-2 font-semibold text-teal-900"><CheckCircle2 className="size-5" />Đã lưu lượt đánh giá</p><p className="mt-2 text-sm leading-6 text-teal-800">{deviceStorage ? 'Đã lưu trên thiết bị này, riêng tài khoản và tổ chức hiện tại. Tải báo cáo JSON để gửi Codex kiểm tra. Công việc chưa ghi vào CRM.' : 'Dữ liệu được lưu trên máy chạy bản thử nghiệm. Công việc chưa được ghi vào CRM.'}</p><Button type="button" className="mt-4 h-12 w-full rounded-xl bg-teal-800 hover:bg-teal-900" onClick={onNew}>Thử một công việc khác</Button></div> : <>
      <Button type="submit" disabled={busy || stale} className="h-14 w-full rounded-2xl bg-teal-800 text-base shadow-sm hover:bg-teal-900">{saving ? <Loader2 className="size-5 animate-spin" /> : <Save className="size-5" />}{saving ? 'Đang lưu đánh giá…' : 'Lưu đánh giá'}</Button>
      <p className="text-center text-xs leading-5 text-slate-500">Chỉ lưu khi bạn bấm nút. Không tạo công việc trong CRM.</p>
    </>}
  </form>;
}
