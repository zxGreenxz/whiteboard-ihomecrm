import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ExecuteButton } from "./ExecuteGuard";

interface MaintenanceDialogProps {
  buildingId: string;
  buildingName: string;
  canExecute: boolean;
  disabledReason: string;
  onCreate: (input: { durationMinutes: number; reason: string }) => void;
}

export function MaintenanceDialog({ buildingId, buildingName, canExecute, disabledReason, onCreate }: MaintenanceDialogProps) {
  const [open, setOpen] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const resetDraft = useCallback(() => {
    setDurationMinutes(60);
    setReason("");
    setError("");
  }, []);

  useEffect(() => {
    setOpen(false);
    resetDraft();
  }, [buildingId, resetDraft]);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) resetDraft();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      onCreate({ durationMinutes, reason });
      changeOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể tạo bảo trì mô phỏng");
    }
  };

  if (!canExecute) {
    return (
      <ExecuteButton canExecute={false} disabledReason={disabledReason} variant="outline">
        <CalendarClock data-icon="inline-start" aria-hidden="true" /> Tạo bảo trì
      </ExecuteButton>
    );
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><CalendarClock data-icon="inline-start" aria-hidden="true" /> Tạo bảo trì</Button>
      </DialogTrigger>
      <DialogContent className="network-center network-center-dialog nc-dialog">
        <DialogHeader>
          <DialogTitle>Tạo cửa sổ bảo trì mô phỏng cục bộ</DialogTitle>
          <DialogDescription>
            Chỉ cập nhật bộ nhớ demo của {buildingName}; không tắt cảnh báo hay thay đổi hệ thống thật.
          </DialogDescription>
        </DialogHeader>
        <form className="nc-form" onSubmit={submit}>
          <div className="nc-field">
            <Label htmlFor="maintenance-duration">Thời lượng (phút)</Label>
            <Input
              id="maintenance-duration"
              type="number"
              min={15}
              max={480}
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(Number(event.target.value))}
            />
          </div>
          <div className="nc-field">
            <Label htmlFor="maintenance-reason">Lý do</Label>
            <Textarea
              id="maintenance-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Kiểm tra kết nối định kỳ"
            />
          </div>
          {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Huỷ</Button>
            <Button type="submit" disabled={!canExecute}>Tạo mô phỏng cục bộ</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
