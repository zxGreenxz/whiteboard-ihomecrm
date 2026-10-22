import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Film, ImageIcon } from 'lucide-react';
import { useOrganization } from '@/contexts/OrganizationContext';
import { useSignedUrl } from '@/hooks/useSignedUrl';
import { readMeterEvidence } from '@/lib/meter-capture/service';
import { StorageImage } from '@/components/ui/storage-image';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

/** Internal only. Do not import into public invoice or print renderers. */
export function MeterEvidenceThumb({ captureId, label = 'Ảnh chỉ số' }: { captureId?: string | null; label?: string }) {
  const { selectedOrganizationId } = useOrganization();
  const [open, setOpen] = useState(false);
  const [play, setPlay] = useState(false);
  const evidence = useQuery({ queryKey: ['meter-capture-evidence', selectedOrganizationId, captureId],
    queryFn: () => readMeterEvidence(selectedOrganizationId!, captureId!), enabled: !!selectedOrganizationId && !!captureId,
    staleTime: 60_000, retry: false });
  const video = useSignedUrl(open && play ? evidence.data?.videoUrl : null);
  if (!captureId) return null;
  return <>
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild><button type="button" className="inline-flex h-9 w-12 shrink-0 overflow-hidden rounded border bg-muted" aria-label={`Mở ${label.toLowerCase()}`} onClick={() => { setPlay(false); setOpen(true); }}>
        {evidence.isError ? <span className="text-xs text-destructive">Lỗi ảnh</span> : <StorageImage value={evidence.data?.imageUrl} className="h-full w-full object-cover" alt={label} fallback={<ImageIcon className="m-auto h-4 w-4" />} />}
      </button></HoverCardTrigger>
      <HoverCardContent className="w-80 p-2" side="top"><StorageImage value={evidence.data?.imageUrl} className="max-h-72 w-full object-contain" alt={label} /><p className="text-xs">Bấm để mở lớn{evidence.data?.videoUrl ? ' và xem clip' : ''}.</p></HoverCardContent>
    </HoverCard>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-w-4xl"><DialogTitle>{label} · Nội bộ</DialogTitle>
      <DialogDescription>Đối chiếu chỉ số với ảnh gốc hoặc thời điểm tương ứng trong clip đồng hồ.</DialogDescription>
      {evidence.isError ? <p role="alert">Không tải được chứng cứ. <button onClick={() => void evidence.refetch()}>Thử lại</button></p> : <>
        {play && video ? <video controls autoPlay playsInline className="max-h-[70vh] w-full" src={video} onLoadedMetadata={event => { event.currentTarget.currentTime = evidence.data?.timestampSeconds ?? 0; }} />
          : <StorageImage value={evidence.data?.imageUrl} className="max-h-[70vh] w-full object-contain" alt={label} />}
        {evidence.data?.videoUrl && <button type="button" className="inline-flex items-center gap-2 text-sm underline" onClick={() => setPlay(value => !value)}><Film className="h-4 w-4" />{play ? 'Xem ảnh chốt' : 'Xem clip đối chiếu'}</button>}
      </>}
    </DialogContent></Dialog>
  </>;
}
