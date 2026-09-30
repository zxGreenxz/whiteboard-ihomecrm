import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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
import { maintenanceFieldErrors, networkFeedback } from '@/lib/network-center/feedback';
import { focusFirstError } from '@/lib/formErrors';
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const uncertainBuildings = useRef(new Set<string>());
  const [submitting, setSubmitting] = useState(false);
  const executionAllowed = allowsNetworkExecution(canExecute, rolloutState);

  const resetDraft = useCallback(() => {
    setDurationMinutes(60);
    setReason("");
    setError("");
    setFieldErrors({});
    setSubmitting(false);
  }, []);

  useEffect(() => {
    setOpen(false);
    resetDraft();
    setUncertain(uncertainBuildings.current.has(buildingId));
  }, [buildingId, resetDraft]);

  const changeOpen = (nextOpen: boolean) => {
    if (pending.current) return;
    setOpen(nextOpen);
    if (!nextOpen && !uncertain) resetDraft();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || uncertain) return;
    const errors = maintenanceFieldErrors({ durationMinutes, reason });
    setFieldErrors(errors);
    if (Object.keys(errors).length) { void focusFirstError(errors, { root: formRef.current }); return; }
    pending.current = true;
    setError("");
    setSubmitting(true);
    try {
      await onCreate({ durationMinutes, reason });
      pending.current = false;
      changeOpen(false);
    } catch (caught) {
      const feedback = networkFeedback(caught, `tạo lịch bảo trì cho ${buildingName}`);
      setError(feedback.description);
      setUncertain(feedback.outcome === "unknown");
      if (feedback.outcome === "unknown") uncertainBuildings.current.add(buildingId);
    } finally {
      pending.current = false;
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
              : `Tạo lịch bảo trì cho ${buildingName}; hệ thống tiếp tục ghi nhận trạng thái và giảm các cảnh báo liên quan đến bảo trì.`}
          </DialogDescription>
        </DialogHeader>
        <form ref={formRef} noValidate className="nc-form" onSubmit={submit}>
          <div className="nc-field">
            <Label htmlFor="maintenance-duration">Thời lượng (phút)</Label>
            <Input
              id="maintenance-duration" name="durationMinutes" aria-invalid={Boolean(fieldErrors.durationMinutes)} aria-describedby={fieldErrors.durationMinutes ? "maintenance-duration-error" : undefined} disabled={submitting}
              type="number"
              min={15}
              max={480}
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(Number(event.target.value))}
            />
            {fieldErrors.durationMinutes ? <p id="maintenance-duration-error" className="nc-form-error" role="alert">{fieldErrors.durationMinutes}</p> : null}
          </div>
          <div className="nc-field">
            <Label htmlFor="maintenance-reason">Lý do</Label>
            <Textarea
              id="maintenance-reason" name="reason" aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={fieldErrors.reason ? "maintenance-reason-error" : undefined} disabled={submitting}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ví dụ: Kiểm tra kết nối định kỳ"
            />
            {fieldErrors.reason ? <p id="maintenance-reason-error" className="nc-form-error" role="alert">{fieldErrors.reason}</p> : null}
          </div>
          {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
          {uncertain ? <p role="status">Đóng hộp thoại và tải lại trạng thái bảo trì của tòa nhà để đối chiếu trước khi tạo thêm.</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>Huỷ</Button>
            <Button type="submit" disabled={!executionAllowed || submitting || uncertain}>
              {submitting ? "Đang tạo…" : isDemo ? "Tạo mô phỏng cục bộ" : "Tạo bảo trì"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
