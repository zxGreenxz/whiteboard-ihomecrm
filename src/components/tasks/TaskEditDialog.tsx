import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBuildings } from "@/hooks/useBuildings";
import { useRooms } from "@/hooks/useRooms";
import { useJobTypes } from "@/hooks/useJobTypes";
import { useProfiles, useUpdateJob } from "@/hooks/useJobs";
import { useIsMobile } from "@/hooks/use-mobile";
import { JOB_PRIORITIES, PRIORITY_LABELS, type JobWithRelations, type JobPriority } from "@/types/jobs";

interface TaskEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: JobWithRelations | null;
  onSuccess: () => void;
}

function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TaskEditDialog({
  open,
  onOpenChange,
  job,
  onSuccess,
}: TaskEditDialogProps) {
  const { data: buildings = [] } = useBuildings();
  const { data: jobTypes = [] } = useJobTypes();
  const { data: profiles = [] } = useProfiles();
  const updateJob = useUpdateJob();
  const isMobile = useIsMobile();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [jobTypeId, setJobTypeId] = useState<string | null>(null);
  const [priority, setPriority] = useState<JobPriority>("NORMAL");
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [deadlineLocal, setDeadlineLocal] = useState<string>("");

  const { data: roomsForBuilding = [] } = useRooms(buildingId ?? undefined);

  useEffect(() => {
    if (open && job) {
      setTitle(job.title);
      setDescription(job.description ?? "");
      setBuildingId(job.building_id);
      setRoomId(job.room_id);
      setJobTypeId(job.job_type_id);
      setPriority(job.priority);
      setAssigneeId(job.assignee_id);
      setDeadlineLocal(toDatetimeLocal(job.deadline));
    }
  }, [open, job]);

  if (!job) return null;

  const handleBuildingChange = (v: string) => {
    const next = v === "__none__" ? null : v;
    setBuildingId(next);
    if (next !== buildingId) setRoomId(null);
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    try {
      await updateJob.mutateAsync({
        id: job.id,
        patch: {
          title: title.trim(),
          description: description.trim() || null,
          building_id: buildingId,
          room_id: roomId,
          job_type_id: jobTypeId,
          priority,
          assignee_id: assigneeId,
          deadline: deadlineLocal ? new Date(deadlineLocal).toISOString() : null,
        },
      });
      onOpenChange(false);
      onSuccess();
    } catch {
      // toast handled by hook
    }
  };

  const formBody = (
    <>
      <div className="space-y-1">
        <label className="text-[13px] font-medium block">
          Tiêu đề <span className="text-red-500">*</span>
        </label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="space-y-1">
        <label className="text-[13px] font-medium block">Mô tả</label>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[13px] font-medium block">Tòa nhà</label>
          <Select
            value={buildingId ?? "__none__"}
            onValueChange={handleBuildingChange}
          >
            <SelectTrigger>
              <SelectValue placeholder="-- Chọn --" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">-- Chọn --</SelectItem>
              {buildings.map((b: any) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[13px] font-medium block">Phòng</label>
          <Select
            value={roomId ?? "__none__"}
            onValueChange={(v) => setRoomId(v === "__none__" ? null : v)}
            disabled={!buildingId}
          >
            <SelectTrigger>
              <SelectValue placeholder="Toàn tòa nhà" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Toàn tòa nhà</SelectItem>
              {roomsForBuilding.map((r: any) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[13px] font-medium block">Loại công việc</label>
          <Select
            value={jobTypeId ?? "__none__"}
            onValueChange={(v) => setJobTypeId(v === "__none__" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="-- Chọn --" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">-- Chọn --</SelectItem>
              {jobTypes.map((t: any) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[13px] font-medium block">Mức độ ưu tiên</label>
          <Select
            value={priority}
            onValueChange={(v) => setPriority(v as JobPriority)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {JOB_PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[13px] font-medium block">Người thực hiện</label>
          <Select
            value={assigneeId ?? "__none__"}
            onValueChange={(v) => setAssigneeId(v === "__none__" ? null : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="-- Chọn --" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">-- Chọn --</SelectItem>
              {profiles.map((p: any) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[13px] font-medium block">Hạn hoàn thành</label>
          <Input
            type="datetime-local"
            value={deadlineLocal}
            onChange={(e) => setDeadlineLocal(e.target.value)}
          />
        </div>
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          isMobile
            ? "max-w-full w-full h-[100dvh] !top-auto !bottom-0 !left-0 !translate-x-0 !translate-y-0 rounded-t-2xl rounded-b-none flex flex-col p-0 gap-0 data-[state=open]:!slide-in-from-bottom data-[state=closed]:!slide-out-to-bottom"
            : "sm:max-w-[640px] max-h-[90vh] overflow-y-auto"
        }
      >
        {isMobile ? (
          <>
            <div className="shrink-0 pt-2 pb-1 flex justify-center">
              <div className="w-10 h-1 bg-zinc-300 rounded-full" />
            </div>
            <DialogHeader className="shrink-0 px-4 pb-2.5 border-b">
              <DialogTitle className="text-blue-600 uppercase font-semibold text-base">
                Sửa công việc
              </DialogTitle>
              <p className="text-xs text-muted-foreground">{job.code}</p>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {formBody}
            </div>
            <DialogFooter className="shrink-0 px-4 py-3 border-t flex flex-col gap-2 bg-background">
              <Button
                className="bg-blue-600 hover:bg-blue-700 text-white w-full h-11"
                disabled={!title.trim() || updateJob.isPending}
                onClick={handleSubmit}
              >
                {updateJob.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="w-full h-11"
              >
                Huỷ
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-blue-600 uppercase font-semibold">
                SỬA CÔNG VIỆC - {job.code}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">{formBody}</div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Huỷ
              </Button>
              <Button
                className="bg-blue-600 hover:bg-blue-700 text-white"
                disabled={!title.trim() || updateJob.isPending}
                onClick={handleSubmit}
              >
                {updateJob.isPending ? "Đang lưu..." : "Lưu"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
