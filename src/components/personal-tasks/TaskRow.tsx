import { useRef, useState, type PointerEvent } from 'react';
import { Check, Clock3, MoreHorizontal, Undo2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { addDaysISO } from '@/lib/vnDate';
import { dayLabel } from '@/lib/personal-tasks/calendar';
import { isOverdue, vnClock, type PersonalTask, type TaskStatus } from '@/lib/personal-tasks/model';

interface Props {
  task: PersonalTask; area: TaskStatus; now: Date; busy: boolean;
  onDue: () => void; onDone: () => void; onUndo: () => void;
}
export function TaskRow({ task, area, now, busy, onDue, onDone, onUndo }: Props) {
  const [offset, setOffset] = useState(0);
  const gesture = useRef<{ x: number; y: number; dx: number; vertical: boolean; id: number } | null>(null);
  const done = task.status === 'done';
  const late = isOverdue(task, now);
  const today = vnClock(now).day;
  const dueDay = task.due?.iso;
  const dueLabel = dueDay === today ? 'hôm nay' : dueDay === addDaysISO(today, 1) ? 'mai' : dueDay ? dayLabel(dueDay, today) : '';
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (busy || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('button')) return;
    gesture.current = { x: event.clientX, y: event.clientY, dx: 0, vertical: false, id: event.pointerId };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.vertical || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x; const dy = event.clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { start.vertical = true; setOffset(0); return; }
    if (Math.abs(dx) < 8) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.dx = dx;
    setOffset(Math.max(-132, Math.min(132, done && dx > 0 ? dx / 4 : dx)));
  };
  const cancel = () => { gesture.current = null; setOffset(0); };
  const onPointerUp = () => {
    const start = gesture.current;
    cancel();
    if (!start || start.vertical || busy) return;
    if (start.dx <= -72) { if (done) onUndo(); else onDue(); }
    else if (start.dx >= 72 && !done) onDone();
  };
  return (
    <div className={`ptask-row ${done ? 'is-done' : ''}`} data-task-id={task.id}>
      <div aria-hidden="true" className={`ptask-swipe ${offset > 0 ? 'right' : done ? 'undo' : 'left'}`}>
        {offset > 0 ? <><Check size={18} /> Xong</> : done ? <>Trả lại <Undo2 size={18} /></> : <>Hẹn giờ <Clock3 size={18} /></>}
      </div>
      <div className="ptask-row-face" style={{ transform: `translateX(${offset}px)`, transition: offset ? 'none' : undefined }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={cancel} onLostPointerCapture={cancel}>
        {area === 'done' && <span className="ptask-done-check"><Check size={13} /></span>}
        {area === 'doing' && <span className={`ptask-clock ${late ? 'late' : ''}`}><Clock3 size={19} /></span>}
        <div className="ptask-row-text">
          <span className="ptask-task-text">{task.text}</span>
          {area === 'doing' && task.due && <span className={`ptask-due-chip ${late ? 'late' : ''}`}>
            {late ? 'Quá hạn · ' : ''}{task.due.time} {dueLabel}
          </span>}
        </div>
        {done && <time className="ptask-done-time">{task.doneTime}</time>}
        <div className="ptask-row-actions">
          {done ? <button disabled={busy} onClick={onUndo} aria-label="Trả lại Cần làm" className="ptask-action undo"><Undo2 size={18} /></button> : <>
            <button disabled={busy} onClick={onDue} aria-label={task.due ? 'Đổi hẹn' : 'Hẹn giờ'} className="ptask-action due"><Clock3 size={18} /></button>
            <button disabled={busy} onClick={onDone} aria-label="Đánh dấu xong" className="ptask-action done"><Check size={19} /></button>
          </>}
        </div>
        <div className="ptask-touch-menu">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="ptask-more" disabled={busy} aria-label={`Thao tác: ${task.text}`}><MoreHorizontal size={18} /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {done ? <DropdownMenuItem onSelect={onUndo}><Undo2 className="mr-2 h-4 w-4" />Trả lại Cần làm</DropdownMenuItem> : <>
                <DropdownMenuItem onSelect={onDue}><Clock3 className="mr-2 h-4 w-4" />{task.due ? 'Đổi hẹn' : 'Hẹn giờ'}</DropdownMenuItem>
                <DropdownMenuItem onSelect={onDone}><Check className="mr-2 h-4 w-4" />Đánh dấu xong</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
