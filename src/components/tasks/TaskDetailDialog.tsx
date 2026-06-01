import { useEffect, useState } from "react";
import { format } from "date-fns";
import { FileText, X, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSignedUrl } from "@/hooks/useSignedUrl";
import { StorageImage } from "@/components/ui/storage-image";
import type { JobWithRelations } from "@/types/jobs";
import { getStatusColor, getStatusLabel } from "@/lib/jobValidation";
import MaterialUsageSection from "@/components/materials/MaterialUsageSection";

interface TaskDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobWithRelations | null;
  onComplete: () => void;
  onEdit: () => void;
  onAddNotes: () => void;
  onDelete?: () => void;
}

const isPdf = (url: string) =>
  url.toLowerCase().endsWith(".pdf") || url.includes(".pdf");

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  try {
    return format(new Date(dateStr), "dd/MM/yyyy HH:mm");
  } catch {
    return "—";
  }
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] border-b border-zinc-200 last:border-b-0">
      <div className="px-3 py-2 bg-zinc-50 text-[13px] text-muted-foreground border-r border-zinc-200">
        {label}
      </div>
      <div className="px-3 py-2 text-[14px]">{value || "—"}</div>
    </div>
  );
}

export default function TaskDetailDialog({
  open,
  onOpenChange,
  job,
  onComplete,
  onEdit,
  onAddNotes,
  onDelete,
}: TaskDetailDialogProps) {
  const isMobile = useIsMobile();
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const attachments = job?.attachments ?? [];
  const isLightboxOpen = lightboxIdx !== null;
  const lightboxUrl =
    lightboxIdx !== null ? attachments[lightboxIdx] ?? null : null;
  const lightboxSignedUrl = useSignedUrl(lightboxUrl);
  const hasMultiple = attachments.length > 1;

  const closeLightbox = () => setLightboxIdx(null);
  const goPrev = () =>
    setLightboxIdx((i) =>
      i === null || attachments.length === 0
        ? i
        : (i - 1 + attachments.length) % attachments.length,
    );
  const goNext = () =>
    setLightboxIdx((i) =>
      i === null || attachments.length === 0 ? i : (i + 1) % attachments.length,
    );

  useEffect(() => {
    if (!open) setLightboxIdx(null);
  }, [open]);

  useEffect(() => {
    if (!isLightboxOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        closeLightbox();
      } else if (e.key === "ArrowLeft" && hasMultiple) {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight" && hasMultiple) {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isLightboxOpen, hasMultiple]);

  if (!job) return null;

  const isInProgress = job.status === "IN_PROGRESS";
  const isCompleted = job.status === "COMPLETED";
  const location = job.buildings?.name
    ? `${job.rooms?.name ?? "Toàn nhà"} - ${job.buildings.name}`
    : (job.rooms?.name ?? "");
  const assignee = job.profiles?.full_name || job.assignee_name || null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className={
            isMobile
              ? "max-w-full w-full h-[100dvh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none flex flex-col p-0 gap-0 data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
              : "sm:max-w-[600px] max-h-[90vh] overflow-y-auto"
          }
          onPointerDownOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (isLightboxOpen) e.preventDefault();
          }}
        >
          {isMobile ? (
            <>
              <div className="shrink-0 pt-2 pb-1 flex justify-center">
                <div className="w-10 h-1 bg-zinc-300 rounded-full" />
              </div>
              <DialogHeader className="shrink-0 px-4 pb-2.5 border-b">
                <DialogTitle className="text-primary uppercase tracking-wide text-base">
                  Chi tiết công việc
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Thông tin chi tiết công việc {job.code}
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                <div className="rounded-md border border-zinc-200 overflow-hidden">
                  <Row label="Phòng - Căn hộ" value={location || "—"} />
                  <Row label="Tiêu đề" value={job.title} />
                  <Row
                    label="Trạng thái"
                    value={
                      <Badge className={getStatusColor(job.status)}>
                        {getStatusLabel(job.status)}
                      </Badge>
                    }
                  />
                  <Row label="Ngày tạo" value={formatDateTime(job.created_at)} />
                  <Row
                    label="Ngày hoàn thành"
                    value={formatDateTime(job.completion_time)}
                  />
                  {assignee && <Row label="Người thực hiện" value={assignee} />}
                  {isCompleted && job.completion_description && (
                    <Row
                      label="Ghi chú đánh giá"
                      value={
                        <span className="whitespace-pre-wrap">
                          {job.completion_description}
                        </span>
                      }
                    />
                  )}
                </div>

                <MaterialUsageSection jobId={job.id} />

                {attachments.length > 0 && (
                  <div>
                    <h3 className="text-[13px] font-semibold mb-1.5 text-muted-foreground">
                      Ảnh đính kèm
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((url, idx) => (
                        <button
                          type="button"
                          key={url}
                          onClick={() => setLightboxIdx(idx)}
                          className="group relative w-20 h-20 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 active:scale-95 transition-transform"
                        >
                          {isPdf(url) ? (
                            <div className="flex items-center justify-center w-full h-full">
                              <FileText className="h-8 w-8 text-muted-foreground" />
                            </div>
                          ) : (
                            <StorageImage
                              value={url}
                              alt="Đính kèm"
                              className="w-full h-full object-cover"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter className="shrink-0 px-4 py-3 border-t flex flex-col gap-2 bg-background">
                {isInProgress && (
                  <>
                    <Button
                      className="bg-green-600 hover:bg-green-700 text-white w-full h-11"
                      onClick={onComplete}
                    >
                      Hoàn thành
                    </Button>
                    <Button
                      variant="outline"
                      onClick={onEdit}
                      className="w-full h-11"
                    >
                      Sửa phiếu
                    </Button>
                  </>
                )}
                {isCompleted && (
                  <Button
                    className="bg-green-600 hover:bg-green-700 text-white w-full h-11"
                    onClick={onAddNotes}
                  >
                    Ghi chú đánh giá
                  </Button>
                )}
                {onDelete && (
                  <Button
                    variant="outline"
                    onClick={onDelete}
                    className="w-full h-11 border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                  >
                    Xoá phiếu
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-primary uppercase tracking-wide">
                  Chi tiết công việc
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Thông tin chi tiết công việc {job.code}
                </DialogDescription>
              </DialogHeader>

              <div className="rounded-md border border-zinc-200 overflow-hidden mt-2">
                <Row label="Phòng - Căn hộ" value={location || "—"} />
                <Row label="Tiêu đề" value={job.title} />
                <Row
                  label="Trạng thái"
                  value={
                    <Badge className={getStatusColor(job.status)}>
                      {getStatusLabel(job.status)}
                    </Badge>
                  }
                />
                <Row label="Ngày tạo" value={formatDateTime(job.created_at)} />
                <Row
                  label="Ngày hoàn thành"
                  value={formatDateTime(job.completion_time)}
                />
                {assignee && <Row label="Người thực hiện" value={assignee} />}
                {isCompleted && job.completion_description && (
                  <Row
                    label="Ghi chú đánh giá"
                    value={
                      <span className="whitespace-pre-wrap">
                        {job.completion_description}
                      </span>
                    }
                  />
                )}
              </div>

              <MaterialUsageSection jobId={job.id} className="mt-3" />

              {attachments.length > 0 && (
                <div className="mt-3">
                  <h3 className="text-sm font-semibold mb-2">Ảnh đính kèm</h3>
                  <div className="flex flex-wrap gap-3">
                    {attachments.map((url, idx) => (
                      <button
                        type="button"
                        key={url}
                        onClick={() => setLightboxIdx(idx)}
                        className="group relative w-24 h-24 rounded-md border border-zinc-200 overflow-hidden bg-zinc-50 hover:border-primary hover:shadow-md transition-all cursor-zoom-in"
                        title="Click để xem lớn"
                      >
                        {isPdf(url) ? (
                          <div className="flex items-center justify-center w-full h-full">
                            <FileText className="h-10 w-10 text-muted-foreground" />
                          </div>
                        ) : (
                          <StorageImage
                            value={url}
                            alt="Đính kèm"
                            className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-110"
                          />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <DialogFooter className="mt-4">
                {isInProgress && (
                  <>
                    <Button variant="outline" onClick={onEdit}>
                      Sửa phiếu
                    </Button>
                    <Button
                      className="bg-green-600 hover:bg-green-700 text-white"
                      onClick={onComplete}
                    >
                      Hoàn thành
                    </Button>
                  </>
                )}
                {isCompleted && (
                  <Button
                    className="bg-green-600 hover:bg-green-700 text-white"
                    onClick={onAddNotes}
                  >
                    Ghi chú đánh giá
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-6 pointer-events-auto"
          onClick={closeLightbox}
        >
          <button
            type="button"
            className="absolute top-4 right-4 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            onClick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
            title="Đóng (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
          {hasMultiple && (
            <>
              <button
                type="button"
                className="absolute left-4 top-1/2 -translate-y-1/2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
                onClick={(e) => {
                  e.stopPropagation();
                  goPrev();
                }}
                title="Ảnh trước (←)"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
                onClick={(e) => {
                  e.stopPropagation();
                  goNext();
                }}
                title="Ảnh sau (→)"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/90 text-sm bg-black/40 rounded-full px-3 py-1">
                {(lightboxIdx ?? 0) + 1} / {attachments.length}
              </div>
            </>
          )}
          {isPdf(lightboxUrl) ? (
            <iframe
              src={lightboxSignedUrl}
              className="w-full h-full max-w-5xl max-h-[90vh] bg-white rounded-md"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <StorageImage
              value={lightboxUrl}
              alt="Đính kèm phóng lớn"
              className="max-w-[95vw] max-h-[90vh] object-contain rounded-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </>
  );
}
