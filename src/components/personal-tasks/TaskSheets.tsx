import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { formatISODayMonth } from '@/lib/vnDate';
import { dueSchema, textSchema, type PersonalTask } from '@/lib/personal-tasks/model';
import { holiday, lunarDate, monthCells, shiftMonth } from '@/lib/personal-tasks/calendar';

function Sheet({ title, description, children, onClose }: { title: string; description: string; children: ReactNode; onClose: () => void }) {
  const previousFocus = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)[0];
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="ptask-sheet" hideClose onPointerDownOutside={() => {}} onInteractOutside={() => {}} onEscapeKeyDown={() => {}}
      onOpenAutoFocus={event => {
        const input = document.getElementById('personal-task-text');
        if (input) { event.preventDefault(); input.focus(); }
      }}
      onCloseAutoFocus={event => { event.preventDefault(); previousFocus?.focus(); }}>
      <div className="ptask-sheet-heading"><DialogTitle>{title}</DialogTitle><DialogClose aria-label="Đóng" className="ptask-close"><X size={20} /></DialogClose></div>
      <DialogDescription className="ptask-sheet-description">{description}</DialogDescription>
      {children}
    </DialogContent>
  </Dialog>;
}
const addSchema = z.object({ text: textSchema });
export function AddTaskSheet({ onClose, onSave, busy }: { onClose: () => void; onSave: (text: string) => Promise<boolean>; busy: boolean }) {
  const { register, handleSubmit, formState: { errors }, watch } = useForm<{ text: string }>({ resolver: zodResolver(addSchema), defaultValues: { text: '' } });
  const submit = handleSubmit(async data => { if (await onSave(data.text)) onClose(); });
  return <Sheet title="Thêm việc" description="Ghi lại một việc bạn muốn làm." onClose={onClose}>
    <form onSubmit={submit} className="ptask-form">
      <label htmlFor="personal-task-text">Nội dung công việc</label>
      <textarea id="personal-task-text" placeholder="Bạn cần làm gì?" rows={3} maxLength={500} {...register('text')}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <div className="ptask-field-hint"><span role="alert">{errors.text?.message}</span><span>{watch('text').length}/500</span></div>
      <div className="ptask-sheet-footer"><button type="button" onClick={onClose} className="ptask-secondary">Hủy</button>
        <button disabled={busy} type="submit" className="ptask-primary">{busy ? 'Đang lưu…' : 'Thêm việc'}</button></div>
    </form>
  </Sheet>;
}
export function DueTaskSheet({ task, today, busy, onClose, onSave, onClear }: {
  task: PersonalTask; today: string; busy: boolean; onClose: () => void;
  onSave: (due: z.infer<typeof dueSchema>) => Promise<boolean>; onClear: () => Promise<boolean>;
}) {
  const { register, setValue, watch, handleSubmit, formState: { errors } } = useForm<z.infer<typeof dueSchema>>({
    resolver: zodResolver(dueSchema), defaultValues: task.due ?? { iso: today, time: '17:00' },
  });
  const selected = watch('iso'); const time = watch('time');
  const [month, setMonth] = useState(selected.slice(0, 7));
  const [year, monthNumber] = month.split('-').map(Number);
  return <Sheet title={task.due ? 'Đổi hẹn hoàn thành' : 'Hẹn hoàn thành'} description={task.text} onClose={onClose}>
    <form className="ptask-form" onSubmit={handleSubmit(async due => { if (await onSave(due)) onClose(); })}>
      <input type="hidden" {...register('iso')} />
      <div className="ptask-calendar-heading">
        <button type="button" disabled={month <= '1900-01'} aria-label="Năm trước" onClick={() => setMonth(shiftMonth(month, -12))}><ChevronsLeft size={18} /></button>
        <button type="button" disabled={month <= '1900-01'} aria-label="Tháng trước" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
        <strong aria-live="polite">Tháng {monthNumber} · {year}</strong>
        <button type="button" disabled={month >= '2199-12'} aria-label="Tháng sau" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
        <button type="button" disabled={month >= '2199-12'} aria-label="Năm sau" onClick={() => setMonth(shiftMonth(month, 12))}><ChevronsRight size={18} /></button>
      </div>
      <div className="ptask-calendar" role="group" aria-label="Chọn ngày hẹn">
        {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map(day => <span key={day} className={`ptask-weekday ${day === 'CN' ? 'holiday' : ''}`}>{day}</span>)}
        {monthCells(month).map((iso, i) => {
          const lunar = lunarDate(iso); const festival = holiday(iso);
          const outside = iso.slice(0, 7) !== month;
          return <button key={iso} type="button" aria-pressed={iso === selected} aria-label={`Ngày ${iso}`} title={festival}
            disabled={iso < '1900-01-01' || iso > '2199-12-31'}
            className={`ptask-day ${outside ? 'outside' : ''} ${i % 7 === 6 || festival ? 'holiday' : ''} ${iso === today ? 'today' : ''} ${iso === selected ? 'selected' : ''}`}
            onClick={() => { setValue('iso', iso, { shouldValidate: true }); setMonth(iso.slice(0, 7)); }}>
            <span>{Number(iso.slice(8))}</span><small>{lunar.day === 1 || lunar.day === 15 ? `${lunar.day}/${lunar.month}` : '\u00a0'}</small>
          </button>;
        })}
      </div>
      <div className="ptask-time-row"><label htmlFor="personal-task-time">Giờ hoàn thành</label><input id="personal-task-time" type="time" {...register('time')} /></div>
      <div className="ptask-time-chips">{['08:00', '14:00', '17:00', '20:00'].map(value => <button type="button" key={value} aria-pressed={value === time}
        onClick={() => setValue('time', value, { shouldValidate: true })}>{value}</button>)}</div>
      {(errors.iso || errors.time) && <p role="alert" className="ptask-form-error">Chọn ngày và giờ hợp lệ.</p>}
      <div className="ptask-sheet-footer"><button type="button" disabled={busy} className="ptask-secondary" onClick={async () => { if (await onClear()) onClose(); }}>Xóa hẹn</button>
        <button type="submit" disabled={busy} className="ptask-primary">Lưu · {time || '—'} {formatISODayMonth(selected)}</button></div>
    </form>
  </Sheet>;
}
