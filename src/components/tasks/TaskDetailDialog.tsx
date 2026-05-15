import { useState } from "react";
import { format } from "date-fns";
import { Paperclip } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { JobWithRelations } from "@/types/jobs";
import {
  getAvailableActions,
  getStatusColor,
  getStatusLabel,
  getPriorityColor,
  getPriorityLabel,
} from "@/lib/jobValidation";

interface TaskDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobWithRelations | null;
  onAcceptTask: () => void;
  onCompleteTask: () => void;
  onReviewTask: () => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  try {
    return format(new Date(dateStr), "dd/MM/yyyy HH:mm");
  } catch {
    return "—";
  }
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-2 border-b border-gray-100">
      <span className="text-sm text-muted-foreground font-medium">{label}</span>
      <div className="col-span-2 text-sm">{children}</div>
    </div>
  );
}

function AttachmentList({ attachments, label }: { attachments: string[] | null; label: string }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-muted-foreground">{label}</h4>
      <div className="flex flex-wrap gap-2">
        {attachments.map((url, idx) => (
          <a
            key={idx}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
          >
            <Paperclip className="h-3 w-3" />
            Tệp {idx + 1}
          </a>
        ))}
      </div>
    </div>
  );
}

export default function TaskDetailDialog({
  open,
  onOpenChange,
  job,
  onAcceptTask,
  onCompleteTask,
  onReviewTask,
}: TaskDetailDialogProps) {
  const [showAcceptConfirm, setShowAcceptConfirm] = useState(false);

  if (!job) return null;

  const actions = getAvailableActions(job.status);

  const handleAcceptConfirm = () => {
    setShowAcceptConfirm(false);
    onAcceptTask();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-blue-600">
              Chi tiết công việc - {job.code}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Thông tin chi tiết công việc {job.code}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <DetailRow label="Mã công việc">{job.code}</DetailRow>
            <DetailRow label="Tiêu đề">{job.title}</DetailRow>
            <DetailRow label="Mô tả">{job.description || "—"}</DetailRow>
            <DetailRow label="Căn hộ">{job.buildings?.name || "—"}</DetailRow>
            <DetailRow label="Phòng">{job.rooms?.name || "—"}</DetailRow>
            <DetailRow label="Giường">{job.beds?.name || "—"}</DetailRow>
            <DetailRow label="Loại công việc">{job.job_types?.name || "—"}</DetailRow>
            <DetailRow label="Mức độ ưu tiên">
              <Badge className={getPriorityColor(job.priority)}>
                {getPriorityLabel(job.priority)}
              </Badge>
            </DetailRow>
            <DetailRow label="Trạng thái">
              <Badge className={getStatusColor(job.status)}>
                {getStatusLabel(job.status)}
              </Badge>
            </DetailRow>
            <DetailRow label="Người thực hiện">
              {job.profiles?.full_name || "—"}
            </DetailRow>
            <DetailRow label="Hạn hoàn thành">
              {formatDate(job.deadline)}
            </DetailRow>
            <DetailRow label="Hiển thị với khách hàng">
              {job.visible_to_customer ? "Có" : "Không"}
            </DetailRow>
            <DetailRow label="Ngày tạo">{formatDate(job.created_at)}</DetailRow>
            <DetailRow label="Ngày cập nhật">{formatDate(job.updated_at)}</DetailRow>
          </div>

          <AttachmentList attachments={job.attachments} label="Đính kèm" />

          {/* Thông tin hoàn thành */}
          {(job.completion_time || job.completion_description || (job.completion_attachments && job.completion_attachments.length > 0)) && (
            <div className="space-y-2 rounded-md border p-4 bg-blue-50/50">
              <h3 className="text-sm font-semibold">Thông tin hoàn thành</h3>
              <div className="space-y-1">
                <DetailRow label="Thời gian hoàn thành">
                  {formatDate(job.completion_time)}
                </DetailRow>
                {job.completion_description && (
                  <DetailRow label="Mô tả kết quả">
                    {job.completion_description}
                  </DetailRow>
                )}
              </div>
              <AttachmentList
                attachments={job.completion_attachments}
                label="Đính kèm hoàn thành"
              />
            </div>
          )}

          {/* Thông tin nghiệm thu */}
          {(job.acceptance_result || job.customer_evaluation || job.customer_comments) && (
            <div className="space-y-2 rounded-md border p-4 bg-green-50/50">
              <h3 className="text-sm font-semibold">Thông tin nghiệm thu</h3>
              <div className="space-y-1">
                {job.acceptance_result && (
                  <DetailRow label="Đánh giá kết quả">
                    {job.acceptance_result}
                  </DetailRow>
                )}
                {job.customer_evaluation && (
                  <DetailRow label="Đánh giá khách hàng">
                    {job.customer_evaluation}
                  </DetailRow>
                )}
                {job.customer_comments && (
                  <DetailRow label="Ý kiến khách hàng">
                    {job.customer_comments}
                  </DetailRow>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            {actions.includes("accept") && (
              <Button
                className="bg-blue-600 hover:bg-blue-700 text-white"
                onClick={() => setShowAcceptConfirm(true)}
              >
                Nhận xử lý
              </Button>
            )}
            {actions.includes("complete") && (
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={onCompleteTask}
              >
                Hoàn thành
              </Button>
            )}
            {actions.includes("review") && (
              <Button
                className="bg-green-600 hover:bg-green-700 text-white"
                onClick={onReviewTask}
              >
                Nghiệm thu công việc
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AlertDialog xác nhận nhận xử lý */}
      <AlertDialog open={showAcceptConfirm} onOpenChange={setShowAcceptConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Xác nhận nhận việc</AlertDialogTitle>
            <AlertDialogDescription>
              Bạn có chắc chắn muốn nhận việc?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Huỷ</AlertDialogCancel>
            <AlertDialogAction onClick={handleAcceptConfirm}>
              Đồng ý
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
