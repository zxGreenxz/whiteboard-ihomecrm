import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { InlineSkeleton } from '@/components/loading/LoadingState';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { useMoveOutNoticeQueue } from '@/hooks/contracts/useMoveOutNoticeQueue';
import { useContractDrafts } from '@/hooks/useContractDrafts';
import { useContractExitCases } from '@/hooks/useContractExitCases';
import { useContractMeterFollowups } from '@/hooks/useContractMeterFollowups';
import { ContractDraftWorkspace } from './ContractDraftWorkspace';
import { ContractExitQueue } from './ContractExitQueue';
import { ContractMeterFollowupQueue } from './ContractMeterFollowupQueue';
import { MoveOutNoticeQueue } from './MoveOutNoticeQueue';

type QueueKey = 'move' | 'exit' | 'meter' | 'draft';

const QUEUES: Record<QueueKey, { label: string; description: string; failed: string }> = {
  move: { label: 'Hẹn trả phòng', description: 'Đã đến ngày khách hẹn. Xác nhận, đổi ngày hoặc hủy báo trả.', failed: 'Không tải được hồ sơ hẹn trả phòng' },
  exit: { label: 'Chờ quyết toán', description: 'Khách đã trả phòng, còn chờ chốt tiền.', failed: 'Không tải được hồ sơ chờ quyết toán' },
  meter: { label: 'Chờ chỉ số', description: 'Đã quyết toán nhưng thiếu chỉ số chốt, hoặc số bổ sung chưa khớp.', failed: 'Không tải được hồ sơ chờ chỉ số' },
  draft: { label: 'Hợp đồng nháp', description: 'Soạn sẵn, tải gửi khách xem trước.', failed: 'Không tải được bản nháp' },
};

function SheetHeading({ queue, count, action }: { queue: QueueKey; count: ReactNode; action?: ReactNode }) {
  return <div className="cm-sheet-head">
    <div className="cm-sheet-titles">
      <SheetTitle className="cm-sheet-title">{QUEUES[queue].label}<span className={`cm-qcount${queue === 'draft' ? '' : ' warn'}`}>{count}</span></SheetTitle>
      <SheetDescription className="cm-sheet-desc">{QUEUES[queue].description}</SheetDescription>
    </div>
    {action}
  </div>;
}

/**
 * Hàng chờ trên đầu trang Hợp đồng mobile: mỗi hàng chỉ một ô đếm, bấm mới mở bảng trượt,
 * để danh sách hợp đồng không bị đẩy khỏi màn hình. Hàng chờ chỉ hiện khi có hồ sơ hoặc đọc
 * lỗi ("!"); chờ dữ liệu thì chưa vẽ. Ô Nháp luôn có vì là lối vào "Soạn nháp".
 */
export function ContractMobileQueues({ buildingId }: { buildingId?: string }) {
  const buildingIds = buildingId ? [buildingId] : [];
  const [open, setOpen] = useState(false);
  // Giữ hàng đang xem sau khi đóng để nội dung không biến mất giữa lúc bảng trượt xuống.
  const [queue, setQueue] = useState<QueueKey>('draft');
  // Cùng khoá truy vấn với trang 1 của từng khung nên không tốn thêm lượt đọc khi mở bảng.
  const move = useMoveOutNoticeQueue(buildingIds, 0);
  const exits = useContractExitCases({ buildingIds, state: 'PENDING', limit: 10, offset: 0 });
  const meter = useContractMeterFollowups(buildingIds, 0);
  const drafts = useContractDrafts(buildingId);
  const draftCount = drafts.data?.filter(draft => draft.status !== 'SIGNED').length;

  const counts: Record<QueueKey, ReactNode> = {
    move: move.isError ? '!' : move.data?.total,
    exit: exits.isError ? '!' : exits.data?.total,
    meter: meter.isError ? '!' : meter.data?.total,
    draft: drafts.isError ? '!' : draftCount ?? <InlineSkeleton label="bản nháp chưa ký" width="0.75rem" />,
  };
  const visible: QueueKey[] = ['move', 'exit', 'meter'];
  const tiles = [...visible.filter(key => counts[key] === '!' || Number(counts[key]) > 0), 'draft' as const];

  return <>
    <div className="cm-qtiles">
      {tiles.map(key => {
        const failed = counts[key] === '!';
        return <button key={key} type="button" className="cm-qtile" aria-haspopup="dialog" title={failed ? QUEUES[key].failed : undefined}
          onClick={() => { setQueue(key); setOpen(true); }}>
          <span className="cm-qtile-label">{QUEUES[key].label}</span>
          <span className={`cm-qcount${key === 'draft' && !failed ? '' : ' warn'}`} aria-label={failed ? QUEUES[key].failed : undefined}>{counts[key]}</span>
          <ChevronRight aria-hidden="true" />
        </button>;
      })}
    </div>
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="bottom" className="cm-sheet flex max-h-[80dvh] flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]">
        {queue === 'draft'
          ? <ContractDraftWorkspace buildingId={buildingId} sheetHeader={action => <SheetHeading queue="draft" count={counts.draft} action={action} />} />
          : <>
            <SheetHeading queue={queue} count={counts[queue]} />
            <div className="cm-qbody">
              {queue === 'move' && <MoveOutNoticeQueue buildingIds={buildingIds} layout="sheet" />}
              {queue === 'exit' && <ContractExitQueue buildingIds={buildingIds} layout="sheet" showEmpty />}
              {queue === 'meter' && <ContractMeterFollowupQueue buildingIds={buildingIds} layout="sheet" />}
            </div>
          </>}
      </SheetContent>
    </Sheet>
  </>;
}
