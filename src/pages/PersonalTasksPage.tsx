import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Bell, CheckCheck, Download, ListTodo, Plus, Clock3 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { usePersonalTasks } from '@/hooks/usePersonalTasks';
import { usePersonalTaskReminders } from '@/hooks/usePersonalTaskReminders';
import { ReminderSheet } from '@/components/personal-tasks/ReminderSheet';
import { TaskRow } from '@/components/personal-tasks/TaskRow';
import { AddTaskSheet, DeleteTaskDialog, DueTaskSheet } from '@/components/personal-tasks/TaskSheets';
import { deriveTasks, vnClock, type PersonalTask, type TaskStatus } from '@/lib/personal-tasks/model';
import { dayLabel, lunarLabel } from '@/lib/personal-tasks/calendar';
import { serializeTasks } from '@/lib/personal-tasks/storage';
import '@/styles/personalTasks.css';

const tabs: { id: TaskStatus; label: string }[] = [{ id: 'todo', label: 'Cần làm' }, { id: 'doing', label: 'Đang xử lý' }, { id: 'done', label: 'Đã xử lý' }];
type SheetState = { type: 'add' | 'reminders' } | { type: 'due' | 'delete'; id: string } | null;

export default function PersonalTasksPage() {
  const { data: user } = useAuth();
  return user ? <PersonalTasksBoard key={user.id} userId={user.id} /> : null;
}

function PersonalTasksBoard({ userId }: { userId: string }) {
  const { tasks, error, loading, busy, refresh, add, change, remove } = usePersonalTasks(userId);
  const reminders = usePersonalTaskReminders(userId);
  const [active, setActive] = useState<TaskStatus>('todo');
  const [sheet, setSheet] = useState<SheetState>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      setNow(new Date());
      timer = window.setTimeout(update, 60_000 - Date.now() % 60_000 + 20);
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, []);
  const today = vnClock(now).day;
  const derived = useMemo(() => deriveTasks(tasks, today), [tasks, today]);
  const dueTask = sheet?.type === 'due' ? tasks.find(task => task.id === sheet.id) : undefined;
  const deleteTask = sheet?.type === 'delete' ? tasks.find(task => task.id === sheet.id) : undefined;
  const row = (task: PersonalTask, area: TaskStatus) => <TaskRow key={task.id} task={task} area={area} now={now} busy={busy || !!error}
    onDelete={() => setSheet({ type: 'delete', id: task.id })} onDue={() => setSheet({ type: 'due', id: task.id })} onDone={() => { void change(task.id, { type: 'done' }); }} onUndo={() => { void change(task.id, { type: 'todo' }); }} />;
  const groupHeader = (day: string, count: string, overdue = false, todo = false) => <div className="ptask-group-heading">
    <div><strong className={overdue ? 'late' : ''}>{dayLabel(day, today, todo)}</strong><span>{lunarLabel(day)}</span></div><span>{count}</span>
  </div>;
  const download = () => {
    const url = URL.createObjectURL(new Blob([serializeTasks(tasks)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `viec-cua-toi-${today}.json`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <main className="ptask-app">
    <header className="ptask-header">
      <div className="ptask-title-row"><Link to="/" aria-label="Về trang chủ" className="ptask-home"><ArrowLeft size={20} /></Link>
        <div className="ptask-title"><h1>Việc của tôi</h1><p>{new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)} <span>· {lunarLabel(today)}</span></p></div>
        <button onClick={download} disabled={loading || !!error} className="ptask-download" aria-label="Tải bản sao công việc" title="Tải bản sao JSON"><Download size={18} /></button>
        <button onClick={() => setSheet({ type: 'reminders' })} className={`ptask-bell ${reminders.error ? 'has-error' : reminders.settings.enabled && reminders.access === 'granted' ? 'enabled' : ''}`} aria-label="Cài đặt nhắc hẹn" title={reminders.error ? 'Nhắc hẹn cần kiểm tra' : 'Cài đặt nhắc hẹn'}><Bell size={18} /></button>
        <span className="ptask-total" aria-live="polite">còn {derived.counts.todo + derived.counts.doing} việc</span>
      </div>
      <p className="ptask-local-note">Lưu trên thiết bị này <span>· chưa đồng bộ</span></p>
      <div className="ptask-tabs" role="tablist" aria-label="Trạng thái công việc">{tabs.map(tab => <button key={tab.id} id={`task-tab-${tab.id}`} role="tab" aria-selected={active === tab.id} aria-controls={`task-panel-${tab.id}`}
        tabIndex={active === tab.id ? 0 : -1}
        onKeyDown={event => {
          const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (!step && event.key !== 'Home' && event.key !== 'End') return;
          event.preventDefault();
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (tabs.findIndex(item => item.id === active) + step + tabs.length) % tabs.length;
          const next = tabs[index].id; setActive(next); document.getElementById(`task-tab-${next}`)?.focus();
        }} onClick={() => setActive(tab.id)}>{tab.label}<span>{derived.counts[tab.id]}</span></button>)}</div>
    </header>
    {error && <div className="ptask-error" role="alert"><p>{error}</p><button onClick={refresh}>Thử lại</button></div>}
    {loading ? <p role="status" className="ptask-loading">Đang đọc việc trên thiết bị…</p> : !error && <div className="ptask-columns">
      {tabs.map(tab => <section key={tab.id} id={`task-panel-${tab.id}`} aria-label={tab.label} className={`ptask-column ${active === tab.id ? 'active' : ''}`}>
        <h2 className="ptask-column-title">{tab.label}<span>{derived.counts[tab.id]}</span></h2>
        <div className="ptask-list">
          {tab.id === 'todo' && <>
            {derived.todoGroups.length > 0 && <p className="ptask-gesture-hint">← hẹn giờ <span>·</span> xong → <span>·</span> giữ để xóa</p>}
            {derived.todoGroups.length === 0 && <div className="ptask-empty"><ListTodo /><strong>Hết việc cần làm.</strong><p>Bấm + để thêm việc mới.</p></div>}
            {derived.todoGroups.map(group => <div className="ptask-group" key={group.day}>
              {groupHeader(group.day, `${group.open.length} việc${group.completed.length ? ` · ${group.completed.length} xong` : ''}`, group.day < today && group.open.length > 0, true)}
              <div className="ptask-card">{group.open.map(task => row(task, 'todo'))}{group.completed.map(task => row(task, 'todo'))}</div>
            </div>)}
          </>}
          {tab.id === 'doing' && <>{derived.doing.length ? <div className="ptask-card">{derived.doing.map(task => row(task, 'doing'))}</div> : <div className="ptask-empty"><Clock3 /><strong>Chưa có việc nào đang xử lý.</strong><p>Hẹn giờ cho một việc ở Cần làm.</p></div>}</>}
          {tab.id === 'done' && <>{derived.doneGroups.length === 0 && <div className="ptask-empty"><CheckCheck /><strong>Chưa có việc nào xong.</strong><p>Những việc hoàn thành sẽ ở đây.</p></div>}
            {derived.doneGroups.map(group => <div className="ptask-group" key={group.day}>{groupHeader(group.day, `${group.tasks.length} việc`)}<div className="ptask-card">{group.tasks.map(task => row(task, 'done'))}</div></div>)}
          </>}
        </div>
      </section>)}
    </div>}
    <button className="ptask-fab" aria-label="Thêm việc" disabled={loading || !!error || busy} onClick={() => setSheet({ type: 'add' })}><Plus size={29} /></button>
    {sheet?.type === 'add' && <AddTaskSheet busy={busy} onClose={() => setSheet(null)} onSave={async text => { const saved = await add(text); if (saved) setActive('todo'); return saved; }} />}
    {dueTask && <DueTaskSheet key={dueTask.id} task={dueTask} today={today} busy={busy} onClose={() => setSheet(null)} onSave={due => change(dueTask.id, { type: 'due', due })} onClear={() => change(dueTask.id, { type: 'todo' })} />}
    {deleteTask && <DeleteTaskDialog task={deleteTask} busy={busy} onClose={() => setSheet(null)} onDelete={() => remove(deleteTask.id)} />}
    {sheet?.type === 'reminders' && <ReminderSheet controller={reminders} onClose={() => setSheet(null)} />}
  </main>;
}
