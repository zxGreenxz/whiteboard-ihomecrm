import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowDownToLine, ArrowRight, AudioLines, Building2, CalendarClock, CheckCircle2, ClipboardList, DoorOpen, Flag, KeyRound, Loader2, LockKeyhole, UserRound, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { displayValue, fieldLabels, type EvaluationSummary, type Prediction } from '@/lib/voice-task-lab/model';

const accessSchema = z.object({ code: z.string().trim().min(1, 'Nhập mã truy cập để tiếp tục.').max(256) });
export function AccessPanel({ busy, onSubmit }: { busy: boolean; onSubmit: (code: string) => void }) {
  const form = useForm<z.infer<typeof accessSchema>>({ resolver: zodResolver(accessSchema), defaultValues: { code: '' } });
  return <section className="rounded-3xl border border-white bg-white p-6 shadow-sm sm:p-8">
    <div className="mb-6 flex size-14 items-center justify-center rounded-2xl bg-teal-50 text-teal-800"><LockKeyhole className="size-7" /></div>
    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Không gian thử nghiệm</p>
    <h2 className="mb-3 mt-2 text-2xl font-semibold tracking-tight text-slate-900">Nói một câu.<br />Xem AI hiểu việc thế nào.</h2>
    <p className="text-sm leading-6 text-slate-500">Dùng mã truy cập được cấp để bắt đầu. Bản thử nghiệm độc lập với tài khoản và dữ liệu CRM.</p>
    <form onSubmit={form.handleSubmit(values => onSubmit(values.code))} className="mt-7 space-y-3">
      <label htmlFor="access-code" className="text-sm font-medium text-slate-700">Mã truy cập</label>
      <Input id="access-code" type="password" autoComplete="current-password" placeholder="Nhập mã truy cập" disabled={busy} className="h-13 h-12 rounded-xl text-base" {...form.register('code')} aria-describedby={form.formState.errors.code ? 'access-error' : undefined} />
      {form.formState.errors.code && <p id="access-error" role="alert" className="text-sm text-rose-700">{form.formState.errors.code.message}</p>}
      <Button disabled={busy} className="h-12 w-full rounded-xl bg-teal-800 text-base hover:bg-teal-900">{busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}{busy ? 'Đang kết nối…' : 'Vào bản thử nghiệm'}</Button>
    </form>
  </section>;
}

export function AudioPreview({ url }: { url: string }) {
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => { const audio = player.current; return () => { if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); } }; }, [url]);
  return <div className="mt-5 rounded-2xl border border-teal-100 bg-white/80 p-3"><p className="mb-2 flex items-center gap-2 text-xs font-medium text-teal-800"><AudioLines className="size-4" />Nghe lại bản ghi</p><audio ref={player} src={url} controls preload="metadata" className="h-10 w-full" aria-label="Nghe lại bản ghi âm" /></div>;
}

const detailIcons = { building: Building2, room: DoorOpen, jobType: Wrench, assignee: UserRound, deadline: CalendarClock, priority: Flag };
export function DraftPanel({ prediction, stale, busy, onReview, onEdit }: { prediction: Prediction; stale: boolean; busy: boolean; onReview: () => void; onEdit: () => void }) {
  return <section className="space-y-5">
    <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">Bước 02 / Công việc</p><h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Từ lời nói thành việc.</h2><p className="mt-2 text-sm leading-6 text-slate-500">Đây là kết quả AI dự đoán. Hãy đối chiếu với điều bạn muốn giao.</p></div>
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4"><span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800"><span className="size-1.5 rounded-full bg-amber-500" />Công việc thử nghiệm · Chưa ghi vào CRM</span><h3 className="mb-1 mt-4 break-words text-xl font-semibold leading-7 text-slate-900">{prediction.predicted.title || 'Chưa xác định nội dung'}</h3>{prediction.predicted.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-500">{prediction.predicted.description}</p>}</div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-5 p-5">{Object.entries(detailIcons).map(([key, Icon]) => {
        const field = key as keyof typeof detailIcons;
        return <div key={field} className={field === 'deadline' ? 'col-span-2' : ''}><dt className="mb-1.5 flex items-center gap-1.5 text-xs text-slate-500"><Icon className="size-3.5" />{fieldLabels[field]}</dt><dd className="break-words text-sm font-medium text-slate-800">{displayValue(field, prediction.predicted[field])}{field === 'deadline' && prediction.predicted[field] && <span className="mt-1 block text-[10px] font-normal text-slate-400">Giờ Việt Nam · Asia/Ho_Chi_Minh</span>}</dd></div>;
      })}</dl>
    </div>
    {prediction.warnings.length > 0 && <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm font-semibold text-amber-900">Cần bạn kiểm tra</p><ul className="mt-2 list-disc space-y-1 pl-4 text-sm leading-6 text-amber-800">{prediction.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    <div className="rounded-2xl bg-slate-100/80 p-4"><div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lời nói đã phân tích</p><Button type="button" variant="ghost" disabled={busy} onClick={onEdit} className="h-9 px-2 text-xs text-teal-800">Sửa văn bản</Button></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">“{prediction.transcript}”</p><p className="mt-3 break-all text-[11px] leading-5 text-slate-400">Model: {prediction.chatModel} · Phân tích {((prediction.latencyMs.extraction ?? 0) / 1000).toFixed(1)} giây</p></div>
    {stale && <p role="status" className="text-sm leading-6 text-amber-800">Văn bản hiện tại khác bản đã phân tích. Hãy phân tích lại để cập nhật.</p>}
    <Button type="button" disabled={busy || stale} onClick={onReview} className="h-14 w-full rounded-2xl bg-teal-800 text-base hover:bg-teal-900">Đánh giá kết quả<ArrowRight className="size-4" /></Button>
  </section>;
}

export function SummaryPanel({ deviceStorage = false, summary, error, busy, onExport }: { deviceStorage?: boolean; summary: EvaluationSummary | null; error: string | null; busy: boolean; onExport: () => void }) {
  const percent = (value: number | null | undefined) => value == null ? '—' : `${Math.round(value)}%`;
  return <aside className="space-y-4 rounded-3xl border border-slate-200/80 bg-white/80 p-5 sm:p-6">
    <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-400">Kết quả thực tế</p><h2 className="mt-1.5 text-lg font-semibold text-slate-900">Nhật ký thử nghiệm</h2></div><ClipboardList className="mt-1 size-5 text-teal-700" /></div>
    <div className="flex items-baseline gap-2"><strong className="text-4xl font-semibold tracking-tight text-slate-900">{summary?.totalRecords ?? '—'}</strong><span className="text-sm text-slate-500">mẫu đã lưu</span></div>
    <div className="space-y-4 border-t border-slate-100 pt-4">
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-700">Đúng từng trường</p><p className="mt-1 text-[11px] text-slate-400">{summary ? `${summary.correctFields}/${summary.reviewedFields} trường được chấm đúng/sai` : 'Chưa tải số mẫu'}</p></div><strong className="text-xl font-semibold text-teal-800">{percent(summary?.fieldAccuracy)}</strong></div>
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-700">Bản nháp hữu ích</p><p className="mt-1 text-[11px] text-slate-400">{summary ? `${summary.usefulRecords}/${summary.ratedRecords} mẫu được chấm từ 4/5` : 'Chưa tải số mẫu'}</p></div><strong className="text-xl font-semibold text-teal-800">{percent(summary?.usefulnessRate)}</strong></div>
      <div className="flex items-start justify-between gap-4"><div><p className="text-sm font-medium text-slate-700">Đúng toàn bộ</p><p className="mt-1 text-[11px] text-slate-400">{summary ? `${summary.fullyCorrectRecords}/${summary.fullyReviewedRecords} mẫu được chấm đủ` : 'Chưa tải số mẫu'}</p></div><strong className="text-xl font-semibold text-teal-800">{percent(summary?.fullCorrectRate)}</strong></div>
    </div>
    {(!summary || summary.totalRecords === 0) && !error && <p className="rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">{summary ? 'Chưa có đánh giá. Thử một câu và tự chấm kết quả để bắt đầu đo.' : 'Đang tải số liệu đánh giá…'}</p>}
    {error && <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800">{error}</p>}
    <p className="text-[11px] leading-5 text-slate-400">Không áp dụng và chưa đánh giá không được tính là đúng. Tỷ lệ luôn đi kèm số mẫu thực tế.</p>
    {!!summary?.groups?.length && <details className="border-t border-slate-100 pt-3"><summary className="cursor-pointer text-xs font-medium text-teal-800">Xem theo nguồn và model ({summary.groups.length})</summary><ul className="mt-3 space-y-3">{summary.groups.map((group, index) => <li key={index} className="rounded-xl bg-slate-50 p-3"><p className="text-xs font-semibold text-slate-700">{group.transcriptSource === '9router' ? 'Ghi âm qua 9Router' : group.transcriptSource === 'browser' ? 'Nhận dạng trình duyệt' : 'Văn bản nhập tay'}</p><p className="mt-1 break-all text-[10px] leading-4 text-slate-400">{group.chatModel}{group.sttModel ? ` · STT: ${group.sttModel}` : ''}</p><p className="mt-2 text-[11px] text-slate-600">{group.totalRecords} mẫu · Đúng {percent(group.fieldAccuracy)} ({group.correctFields}/{group.reviewedFields} trường)</p></li>)}</ul></details>}
    <Button type="button" variant="outline" onClick={onExport} disabled={busy || !summary || summary.totalRecords === 0} className="h-11 w-full rounded-xl border-slate-200 bg-white text-slate-600"><ArrowDownToLine className="size-4" />Tải dữ liệu đánh giá (.json)</Button>
    {deviceStorage && <p className="text-xs leading-5 text-slate-500">Riêng tài khoản và tổ chức hiện tại. Tải báo cáo JSON để gửi Codex kiểm tra. Dữ liệu không đồng bộ sang thiết bị khác và mất khi xóa dữ liệu trình duyệt.</p>}<p className="flex items-center justify-center gap-1.5 text-[10px] text-slate-400"><CheckCircle2 className="size-3" />{deviceStorage ? 'Chỉ lưu trên thiết bị này · Tối đa 100 mẫu' : 'Lưu tại máy chạy bản thử nghiệm'}</p>
  </aside>;
}
