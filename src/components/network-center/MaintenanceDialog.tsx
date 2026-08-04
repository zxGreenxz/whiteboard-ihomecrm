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
import type { NetworkRolloutState } from "@/lib/network-center/contracts";
import { allowsNetworkExecution } from "@/lib/network-center/model";
import { ExecuteButton } from "./ExecuteGuard";

interface MaintenanceDialogProps {
  buildingId: string;
  buildingName: string;
  canExecute: boolean;
  rolloutState: NetworkRolloutState;
  disabledReason: string;
  isDemo?: boolean;
  onCreate: (input: { durationMinutes: number; reason: string }) => Promise<unknown>;
}

export function MaintenanceDialog({ buildingId, buildingName, canExecute, rolloutState, disabledReason, isDemo = false, onCreate }: MaintenanceDialogProps) {
  const [open, setOpen] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const executionAllowed = allowsNetworkExecution(canExecute, rolloutState);

  const resetDraft = useCallback(() => {
    setDurationMinutes(60);
    setReason("");
    setError("");
    setSubmitting(false);
  }, []);

  useEffect(() => {
    setOpen(false);
    resetDraft();
  }, [buildingId, resetDraft]);

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) resetDraft();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onCreate({ durationMinutes, reason });
      changeOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Không thể tạo cửa sổ bảo trì");
    } finally {
      setSubmitting(false);
    }
  };

  if (!executionAllowed) {
    return (
      <ExecuteButton canExecute={canExecute} rolloutState={rolloutState} disabledReason={disabledReason} variant="outline">
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
          <DialogTitle>{isDemo ? "Tạo cửa sổ bảo trì mô phỏng cục bộ" : "Tạo cửa sổ bảo trì"}</DialogTitle>
          <DialogDescription>
            {isDemo
              ? `Chỉ cập nhật bộ nhớ demo của ${buildingName}; không thay đổi hệ thống thật.`
              : `Tạo maintenance window cho ${buildingName}; worker vẫn ghi nhận trạng thái nhưng cảnh báo phù hợp sẽ được giảm nhiễu.`}
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
            <Button type="submit" disabled={!executionAllowed || submitting}>
              {submitting ? "Đang tạo…" : isDemo ? "Tạo mô phỏng cục bộ" : "Tạo bảo trì"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
