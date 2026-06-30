import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Search, SlidersHorizontal, Clock, CheckCircle2 } from 'lucide-react';
import '@/styles/mobileApp.css';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useJobs, useDeleteJob } from '@/hooks/useJobs';
import { useAuth } from '@/hooks/useAuth';
import { useMyPermissions } from '@/hooks/useMyPermissions';
import { canUse } from '@/lib/permissionPages';
import { isOverdue } from '@/lib/jobValidation';
import { TaskFiltersPanel } from '@/components/tasks/TaskFiltersPanel';
import TaskCreateDialog from '@/components/tasks/TaskCreateDialog';
import TaskDetailDialog from '@/components/tasks/TaskDetailDialog';
import TaskEditDialog from '@/components/tasks/TaskEditDialog';
import TaskNotesDialog from '@/components/tasks/TaskNotesDialog';
import TaskCompleteDialog from '@/components/tasks/TaskCompleteDialog';
import type { TaskFilters, JobWithRelations } from '@/types/jobs';
import { defaultTaskFilters } from '@/types/jobs';

type TaskTab = 'ALL' | 'MINE' | 'WATCHING';
type StatusFilter = 'IN_PROGRESS' | 'COMPLETED' | null;

const JSTATUS = {
  IN_PROGRESS: { label: 'Đang làm', c: '#2563eb', bg: '#e7eefc', line: '#c9dafa' },
  COMPLETED: { label: 'Hoàn thành', c: '#1f9d57', bg: '#e6f5ec', line: '#bfe6cd' },
} as const;
const OVERDUE = { c: '#d6453f', bg: '#fcebe9', line: '#f2c8c4' };

const fmtDeadline = (s: string | null) => {
  if (!s) return 'Không hạn';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
};
const shortName = (n: string) => {
  const parts = n.trim().split(/\s+/);
  return parts[parts.length - 1] || n;
};

/**
 * Công việc — màn hình app full-screen trên mobile (web-app). Dựng theo handoff
 * Claude Design (ui_kits/mobile-app: TasksScreen) nhưng nối dữ liệu THẬT: useJobs
 * + tái dùng nguyên bộ dialog desktop (TaskDetail/Create/Edit/Notes/Complete) làm
 * overlay. Quy trình trạng thái THỰC TẾ chỉ IN_PROGRESS ↔ COMPLETED (không phải
 * 4 bước của mock). CSS scope riêng (.cm-stage/.cm-app), ngoài MainLayout.
 */
export default function TasksMobilePage() {
  const navigate = useNavigate();
  const { data: authUser } = useAuth();
  const { data: perms } = useMyPermissions();
  const canCreate = canUse(perms, 'tasks', 'create');

  const [search, setSearch] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<TaskFilters>(defaultTaskFilters);
  const [appliedFilters, setAppliedFilters] = useState<TaskFilters>(defaultTaskFilters);
  const [activeTab, setActiveTab] = useState<TaskTab>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('IN_PROGRESS');
  const [visible, setVisible] = useState(40);

  // Dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState<JobWithRelations | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isNotesOpen, setIsNotesOpen] = useState(false);
  const [completeTarget, setCompleteTarget] = useState<JobWithRelations | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const { data: allJobs = [], isLoading, isError, refetch } = useJobs(appliedFilters);
  const deleteJob = useDeleteJob();

  const myUserId = authUser?.id ?? null;
  const isAssignedToMe = (job: any) =>
    !!myUserId && (job.assignee_id === myUserId || job.profiles?.id === myUserId);
  const isWatching = (job: any) => !!myUserId && !isAssignedToMe(job);

  const jobs = allJobs as JobWithRelations[];
  const tabFiltered = jobs.filter((job) => {
    if (activeTab === 'MINE') return isAssignedToMe(job);
    if (activeTab === 'WATCHING') return isWatching(job);
    return true;
  });
  const tabCounts = {
    ALL: jobs.length,
    MINE: jobs.filter(isAssignedToMe).length,
    WATCHING: jobs.filter(isWatching).length,
  };
  const doing = tabFiltered.filter((j) => j.status === 'IN_PROGRESS').length;
  const done = tabFiltered.filter((j) => j.status === 'COMPLETED').length;

  const q = search.trim().toLowerCase();
  const rows = useMemo(() => {
    let r = tabFiltered;
    if (statusFilter) r = r.filter((j) => j.status === statusFilter);
    if (q) {
      r = r.filter((j) => {
        const assignee = (j.profiles?.full_name || j.assignee_name || '').toLowerCase();
        return (
          j.title.toLowerCase().includes(q) ||
          j.code.toLowerCase().includes(q) ||
          assignee.includes(q)
        );
      });
    }
    return r;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabFiltered, statusFilter, q]);

  const shown = rows.slice(0, visible);

  const activeFilterCount = useMemo(
    () =>
      Object.entries(appliedFilters).filter(([, v]) =>
        Array.isArray(v) ? v.length > 0 : v != null && v !== '',
      ).length,
    [appliedFilters],
  );

  const scopes: { id: TaskTab; label: string }[] = [
    { id: 'ALL', label: 'Tất cả' },
    { id: 'MINE', label: 'Của tôi' },
    { id: 'WATCHING', label: 'Theo dõi' },
  ];

  const openDetail = (job: JobWithRelations) => {
    setSelectedJob(job);
    setIsDetailOpen(true);
  };

  return (
    <div className="cm-stage">
      <div className="cm-app">
        <div className="route route-anim">
          <div className="mtop">
            <button className="mback" onClick={() => navigate('/')} aria-label="Về trang chủ">
              <ArrowLeft />
            </button>
            <div className="mtitle">
              <h1>Công việc</h1>
              <p>Quản lý công việc vận hành</p>
            </div>
            {canCreate && (
              <div className="mtop-act">
                <button className="mtop-btn" onClick={() => setIsCreateOpen(true)}>
                  <Plus />Thêm
                </button>
              </div>
            )}
          </div>

          <div className="mbody">
            <div className="tksearch">
              <div className="tksearch-in">
                <Search />
                <input
                  placeholder="Tìm công việc, người thực hiện…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button
                className={'tkfbtn' + (activeFilterCount ? ' act' : '')}
                onClick={() => setShowFilters(true)}
                aria-label="Bộ lọc"
              >
                <SlidersHorizontal size={17} />
                {activeFilterCount ? <span className="fbadge">{activeFilterCount}</span> : null}
              </button>
            </div>

            <div className="tkseg">
              {scopes.map((s) => (
                <button
                  key={s.id}
                  className={'tkseg-b' + (activeTab === s.id ? ' on' : '')}
                  onClick={() => { setActiveTab(s.id); setVisible(40); }}
                >
                  {s.label}<span className="tkseg-n">{tabCounts[s.id]}</span>
                </button>
              ))}
            </div>

            <div className="tk2">
              <button
                className={'tk2c doing' + (statusFilter === 'IN_PROGRESS' ? ' on' : '')}
                onClick={() => setStatusFilter((p) => (p === 'IN_PROGRESS' ? null : 'IN_PROGRESS'))}
              >
                <div className="tk2c-h">
                  <span className="tk2c-l"><Clock size={14} />Đang làm</span>
                  {statusFilter === 'IN_PROGRESS' ? <span className="tk2c-flt">Đang lọc</span> : null}
                </div>
                <div className="tk2c-n">{doing}</div>
              </button>
              <button
                className={'tk2c done' + (statusFilter === 'COMPLETED' ? ' on' : '')}
                onClick={() => setStatusFilter((p) => (p === 'COMPLETED' ? null : 'COMPLETED'))}
              >
                <div className="tk2c-h">
                  <span className="tk2c-l"><CheckCircle2 size={14} />Hoàn thành</span>
                  {statusFilter === 'COMPLETED' ? <span className="tk2c-flt">Đang lọc</span> : null}
                </div>
                <div className="tk2c-n">{done}</div>
              </button>
            </div>

            {isLoading ? (
              <div className="stub"><p>Đang tải công việc…</p></div>
            ) : isError ? (
              <div className="stub">
                <p>Không tải được công việc.</p>
                <button onClick={() => refetch()} style={{ marginTop: 8, textDecoration: 'underline' }}>Thử lại</button>
              </div>
            ) : shown.length === 0 ? (
              <div className="stub"><p>Không có công việc nào phù hợp.</p></div>
            ) : (
              <div className="rowlist">
                {shown.map((j) => {
                  const overdue = isOverdue(j);
                  const st = JSTATUS[j.status as keyof typeof JSTATUS] ?? JSTATUS.IN_PROGRESS;
                  const borderC = overdue ? OVERDUE.c : st.c;
                  const loc = [j.rooms?.name ? `P.${j.rooms.name}` : '', j.buildings?.name]
                    .filter(Boolean)
                    .join(' · ');
                  const assignee = j.profiles?.full_name || j.assignee_name;
                  return (
                    <button className="job" key={j.id} style={{ borderLeftColor: borderC }} onClick={() => openDetail(j)}>
                      <div className="job-l1">
                        <div className="job-title">{j.title}</div>
                        {j.priority === 'URGENT' && (
                          <span className="pill" style={{ color: OVERDUE.c, background: OVERDUE.bg, borderColor: OVERDUE.line, flexShrink: 0 }}>
                            Gấp
                          </span>
                        )}
                        <span
                          className="pill"
                          style={{ color: st.c, background: st.bg, borderColor: st.line, flexShrink: 0 }}
                        >
                          <span className="bd" style={{ background: st.c }} />{st.label}
                        </span>
                      </div>
                      {(loc || j.job_types?.name) && (
                        <div className="job-sub">
                          {loc}{loc && j.job_types?.name ? ' · ' : ''}{j.job_types?.name ? j.job_types.name.toLowerCase() : ''}
                        </div>
                      )}
                      <div className="job-foot">
                        <span className={'job-when' + (overdue ? ' late' : '')}>
                          <Clock size={12} />{fmtDeadline(j.deadline)}
                        </span>
                        {assignee && <><span className="job-dot">·</span><span className="job-by">{shortName(assignee)}</span></>}
                      </div>
                    </button>
                  );
                })}
                {rows.length > shown.length && (
                  <button className="loadmore" onClick={() => setVisible((v) => v + 40)}>
                    Tải thêm ({rows.length - shown.length})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter sheet (bottom) — tái dùng panel desktop */}
      <Sheet open={showFilters} onOpenChange={setShowFilters}>
        <SheetContent side="bottom" className="h-[85vh] overflow-y-auto p-0">
          <SheetHeader className="px-4 py-3 border-b">
            <SheetTitle>Bộ lọc</SheetTitle>
          </SheetHeader>
          <div className="p-4">
            <TaskFiltersPanel
              filters={filters}
              onChange={setFilters}
              onApply={() => {
                setAppliedFilters(filters);
                setVisible(40);
                setShowFilters(false);
              }}
              onClear={() => {
                setFilters(defaultTaskFilters);
                setAppliedFilters(defaultTaskFilters);
                setVisible(40);
                setShowFilters(false);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Dialogs (overlay, dùng chung với desktop) */}
      <TaskCreateDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} onSuccess={() => setIsCreateOpen(false)} />
      <TaskDetailDialog
        open={isDetailOpen}
        onOpenChange={(open) => { setIsDetailOpen(open); if (!open) setSelectedJob(null); }}
        job={selectedJob}
        onComplete={() => { if (selectedJob) setCompleteTarget(selectedJob); }}
        onEdit={() => { if (selectedJob) { setIsDetailOpen(false); setIsEditOpen(true); } }}
        onAddNotes={() => { if (selectedJob) { setIsDetailOpen(false); setIsNotesOpen(true); } }}
        onDelete={() => { if (selectedJob) { setIsDetailOpen(false); setDeleteTarget(selectedJob.id); } }}
      />
      <TaskEditDialog
        open={isEditOpen}
        onOpenChange={(open) => { setIsEditOpen(open); if (!open) setSelectedJob(null); }}
        job={selectedJob}
        onSuccess={() => { setIsEditOpen(false); setSelectedJob(null); }}
      />
      <TaskNotesDialog
        open={isNotesOpen}
        onOpenChange={(open) => { setIsNotesOpen(open); if (!open) setSelectedJob(null); }}
        job={selectedJob}
        onSuccess={() => { setIsNotesOpen(false); setSelectedJob(null); }}
      />
      <TaskCompleteDialog
        open={!!completeTarget}
        onOpenChange={(open) => { if (!open) setCompleteTarget(null); }}
        job={completeTarget}
        onSuccess={() => { setCompleteTarget(null); setIsDetailOpen(false); setSelectedJob(null); }}
      />
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận xoá</AlertDialogTitle>
            <AlertDialogDescription>Bạn có chắc chắn muốn xoá công việc này không?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTarget) { deleteJob.mutate(deleteTarget); setDeleteTarget(null); } }}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              Xoá
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
