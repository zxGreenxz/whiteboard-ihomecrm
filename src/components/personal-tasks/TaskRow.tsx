import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Check, Clock3, Trash2, Undo2 } from 'lucide-react';
import { addDaysISO } from '@/lib/vnDate';
import { dayLabel } from '@/lib/personal-tasks/calendar';
import { isOverdue, vnClock, type PersonalTask, type TaskStatus } from '@/lib/personal-tasks/model';

interface Props {
  task: PersonalTask; area: TaskStatus; now: Date; busy: boolean;
  onDue: () => void; onDone: () => void; onUndo: () => void; onDelete: () => void;
}
export function TaskRow({ task, area, now, busy, onDue, onDone, onUndo, onDelete }: Props) {
  const [offset, setOffset] = useState(0);
  const holdTimer = useRef<number>();
  const gesture = useRef<{ x: number; y: number; dx: number; vertical: boolean; held: boolean; id: number } | null>(null);
  const cancel = () => { window.clearTimeout(holdTimer.current); gesture.current = null; setOffset(0); };
  useEffect(() => {
    const reset = () => { window.clearTimeout(holdTimer.current); gesture.current = null; setOffset(0); };
    const visibility = () => { if (document.hidden) reset(); };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.clearTimeout(holdTimer.current); window.removeEventListener('blur', reset); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { if (busy) { window.clearTimeout(holdTimer.current); gesture.current = null; setOffset(0); } }, [busy]);
  const done = task.status === 'done';
  const late = isOverdue(task, now);
  const today = vnClock(now).day;
  const dueDay = task.due?.iso;
  const dueLabel = dueDay === today ? 'hôm nay' : dueDay === addDaysISO(today, 1) ? 'mai' : dueDay ? dayLabel(dueDay, today) : '';
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    cancel();
    if (busy || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('button')) return;
    const target = event.currentTarget;
    const start = { x: event.clientX, y: event.clientY, dx: 0, vertical: false, held: false, id: event.pointerId };
    gesture.current = start;
    holdTimer.current = window.setTimeout(() => {
      if (gesture.current !== start || start.vertical) return;
      start.held = true;
      target.focus({ preventScroll: true });
      onDelete();
    }, 600);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || start.held || start.vertical || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x; const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) > 8) window.clearTimeout(holdTimer.current);
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { start.vertical = true; setOffset(0); return; }
    if (Math.abs(dx) < 8) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.dx = dx;
    setOffset(Math.max(-132, Math.min(132, done && dx > 0 ? dx / 4 : dx)));
  };
  const onPointerUp = () => {
    const start = gesture.current;
    cancel();
    if (!start || start.held || start.vertical || busy) return;
    if (start.dx <= -72) { if (done) onUndo(); else onDue(); }
    else if (start.dx >= 72 && !done) onDone();
  };
  return (
    <div className={`ptask-row ${done ? 'is-done' : ''}`} data-task-id={task.id}>
      <div aria-hidden="true" className={`ptask-swipe ${offset > 0 ? 'right' : done ? 'undo' : 'left'}`}>
        {offset > 0 ? <><Check size={18} /> Xong</> : done ? <>Trả lại <Undo2 size={18} /></> : <>Hẹn giờ <Clock3 size={18} /></>}
      </div>
      <div className="ptask-row-face" tabIndex={0} role="group" aria-label={`Công việc: ${task.text}`}
        aria-description="Giữ để xóa. Phím Delete để xóa, mũi tên trái để hẹn hoặc trả lại, mũi tên phải để hoàn thành."
        style={{ transform: `translateX(${offset}px)`, transition: offset ? 'none' : undefined }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={cancel} onLostPointerCapture={cancel} onPointerLeave={() => { window.clearTimeout(holdTimer.current); }}
        onContextMenu={event => {
          event.preventDefault();
          if (busy || (event.target as HTMLElement).closest('button')) return;
          const held = gesture.current?.held;
          cancel();
          if (!held) { event.currentTarget.focus({ preventScroll: true }); onDelete(); }
        }}
        onKeyDown={event => {
          if (busy || event.target !== event.currentTarget) return;
          if (event.key === 'Delete') { event.preventDefault(); onDelete(); }
          if (event.key === 'ArrowLeft') { event.preventDefault(); if (done) onUndo(); else onDue(); }
          if (event.key === 'ArrowRight' && !done) { event.preventDefault(); onDone(); }
        }}>
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
          <button disabled={busy} onClick={onDelete} aria-label="Xóa công việc" className="ptask-action delete"><Trash2 size={18} /></button>
        </div>
      </div>
    </div>
  );
}
