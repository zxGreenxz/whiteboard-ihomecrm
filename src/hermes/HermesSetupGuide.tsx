import { useState, type ReactNode } from 'react';
import { Check, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { HermesConnectionMetadata } from './connectionClient';

/** Hiển thị thuần: các bước chỉ hướng dẫn người dùng, không quyết định quyền hay gửi gì lên máy chủ. */
export type HermesStepState = 'done' | 'current' | 'todo' | 'blocked';
type Lane = 'admin' | 'page' | 'zalo';

export const HERMES_SETUP_STEPS: readonly { title: string; hint: string; lane: Lane }[] = [
  { title: 'Bật Hermes', hint: 'và chọn nick bot', lane: 'admin' },
  { title: 'Tạo kết nối', hint: 'Nhập mật khẩu CRM', lane: 'page' },
  { title: 'Tạo mã Zalo', hint: 'Bấm sao chép mã', lane: 'page' },
  { title: 'Nhắn mã cho bot', hint: 'Từ nick Zalo chính', lane: 'zalo' },
  { title: 'Xác nhận nick', hint: 'Bấm “Ghép nick này”', lane: 'page' },
  { title: 'Kích hoạt trợ lý', hint: 'Bấm tải lại để xem', lane: 'admin' },
  { title: 'Nhắn bot để dùng', hint: 'Hỏi phòng, giao việc', lane: 'zalo' },
];
const laneLabels: Record<Lane, string> = { admin: 'Quản trị · tự động', page: 'Trên trang này', zalo: 'Trên Zalo điện thoại' };
const laneX: Record<Lane, number> = { admin: 135, page: 340, zalo: 545 };
const laneTone: Record<Lane, string> = {
  admin: 'fill-muted stroke-border',
  page: 'fill-primary/10 stroke-primary/50',
  zalo: 'fill-sky-100 stroke-sky-400 dark:fill-sky-950 dark:stroke-sky-700',
};

/** Tên dễ đọc thay cho mã kết nối; mã ngắn vẫn hiện kèm để phân biệt khi cần báo lỗi. */
export function hermesConnectionNames(connections: readonly HermesConnectionMetadata[]) {
  const live = connections.filter(connection => connection.state !== 'revoked');
  const names = new Map<string, string>();
  live.forEach((connection, index) => names.set(connection.id, live.length === 1 ? 'Hermes của tôi' : `Kết nối ${index + 1}`));
  connections.filter(connection => connection.state === 'revoked').forEach(connection => names.set(connection.id, 'Kết nối đã ngắt'));
  return (id: string) => names.get(id) ?? 'Kết nối';
}
export const shortConnectionId = (id: string) => id.slice(-8);

/** Hình hướng dẫn 7 bước theo ba nơi làm. Màn hẹp đổi sang danh sách để chữ không bị thu nhỏ. */
export function HermesSetupFlow() {
  const boxY = (index: number) => 80 + index * 80;
  return <figure aria-label="Hình hướng dẫn cài Hermes" className="space-y-2">
    <svg viewBox="0 0 680 652" role="img" aria-labelledby="hermes-flow-title" className="hidden w-full sm:block">
      <title id="hermes-flow-title">Bảy bước cài Hermes: quản trị bật Hermes, bạn tạo kết nối và mã Zalo trên trang này, nhắn mã cho bot trên Zalo, xác nhận nick, chờ kích hoạt rồi nhắn bot để dùng.</title>
      <defs><marker id="hermes-flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M2 1L8 5L2 9" fill="none" className="stroke-muted-foreground" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></marker></defs>
      {(Object.keys(laneX) as Lane[]).map(lane => <g key={lane}>
        <rect x={laneX[lane] - 95} y="20" width="190" height="612" rx="12" fill="none" className="stroke-border" strokeDasharray="4 4" />
        <text x={laneX[lane]} y="46" textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[14px] font-medium">{laneLabels[lane]}</text>
      </g>)}
      {HERMES_SETUP_STEPS.map((step, index) => <g key={step.title}>
        <rect x={laneX[step.lane] - 88} y={boxY(index)} width="176" height="56" rx="8" strokeWidth="0.75" className={laneTone[step.lane]} />
        <text x={laneX[step.lane]} y={boxY(index) + 18} textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[14px] font-medium">{index + 1}. {step.title}</text>
        <text x={laneX[step.lane]} y={boxY(index) + 38} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground text-[12px]">{step.hint}</text>
      </g>)}
      {HERMES_SETUP_STEPS.slice(1).map((step, offset) => {
        // Mũi tên ra ở nửa dưới cạnh phải, vào ở nửa trên cạnh phải, để hai mũi tên cùng một ô không chồng nhau.
        const from = HERMES_SETUP_STEPS[offset], top = boxY(offset), next = boxY(offset + 1);
        const fromX = laneX[from.lane], toX = laneX[step.lane];
        const d = fromX === toX ? `M${fromX} ${top + 56} L${toX} ${next - 2}`
          : toX > fromX ? `M${fromX + 88} ${top + 40} L${toX} ${top + 40} L${toX} ${next - 2}`
            : `M${fromX} ${top + 56} L${fromX} ${next + 18} L${toX + 90} ${next + 18}`;
        return <path key={step.title} d={d} fill="none" className="stroke-muted-foreground" strokeWidth="1.25" markerEnd="url(#hermes-flow-arrow)" />;
      })}
    </svg>
    <ol className="space-y-2 sm:hidden">
      {HERMES_SETUP_STEPS.map((step, index) => <li key={step.title} className="flex items-center gap-3 rounded-lg border p-2 text-sm">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-muted text-xs font-medium">{index + 1}</span>
        <span className="min-w-0 flex-1"><span className="font-medium">{step.title}</span> <span className="text-muted-foreground">· {step.hint}</span></span>
        <span className="flex-none text-xs text-muted-foreground">{laneLabels[step.lane].split(' · ')[0]}</span>
      </li>)}
    </ol>
  </figure>;
}

/** Thẻ đầu trang: thanh tiến độ 7 bước, câu "bạn đang ở bước nào" và nút xem hình hướng dẫn. */
export function HermesSetupProgress({ done, current, action, initiallyOpen }: { done: readonly boolean[]; current: number | null;
  action?: ReactNode; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const step = current === null ? null : HERMES_SETUP_STEPS[current];
  return <section aria-label="Hướng dẫn cài Hermes" className="space-y-3 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="font-semibold">Cài Hermes trong 7 bước</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}><ImageIcon className="h-4 w-4" />{open ? 'Ẩn hình hướng dẫn' : 'Xem hình hướng dẫn'}</Button>
        {action}
      </div>
    </div>
    <div className="flex gap-1" aria-hidden="true">
      {HERMES_SETUP_STEPS.map((item, index) => <span key={item.title} className={cn('h-1.5 flex-1 rounded-full',
        done[index] || current === null ? 'bg-primary' : index === current ? 'bg-primary/40' : 'bg-muted')} />)}
    </div>
    <p className="text-sm text-muted-foreground">{step && current !== null ? `Bạn đang ở bước ${current + 1}: ${step.title}.`
      : 'Đã cài xong. Nhắn bot trên Zalo để dùng Hermes.'}</p>
    {open && <HermesSetupFlow />}
  </section>;
}

function StepBadge({ state, label }: { state: HermesStepState; label: string }) {
  return <span className={cn('flex h-7 min-w-7 flex-none items-center justify-center rounded-full px-1.5 text-xs font-semibold',
    state === 'done' && 'bg-primary/10 text-primary', state === 'current' && 'bg-primary text-primary-foreground',
    state === 'blocked' && 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
    state === 'todo' && 'border text-muted-foreground')}>
    {state === 'done' ? <Check className="h-4 w-4" aria-label="Đã xong" /> : label}
  </span>;
}

/** Một bước trên trang. Bước đang làm có viền nổi; bước đã xong chỉ còn dòng tóm tắt và các nút cần thiết. */
export function HermesStep({ label, state, title, who, summary, children }: { label: string; state: HermesStepState; title: string;
  who: string; summary?: ReactNode; children?: ReactNode }) {
  return <section aria-label={`Bước ${label}: ${title}`} className={cn('rounded-xl border bg-card p-4',
    state === 'current' && 'border-primary ring-1 ring-primary/30', state === 'blocked' && 'border-amber-500/60')}>
    <div className="flex items-start gap-3">
      <StepBadge state={state} label={label} />
      <div className="min-w-0 flex-1">
        <h2 className={cn('font-semibold', state === 'todo' && 'text-muted-foreground')}>{title}</h2>
        {summary && <div className="text-sm text-muted-foreground">{summary}</div>}
      </div>
      <span className="flex-none rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{who}</span>
    </div>
    {children && <div className="mt-3 space-y-3 sm:pl-10">{children}</div>}
  </section>;
}

export function HermesSectionDivider({ children }: { children: ReactNode }) {
  return <p className="flex items-center gap-2 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground after:flex-1 after:border-t after:content-['']">{children}</p>;
}
