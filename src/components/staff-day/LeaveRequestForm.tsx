// Biểu mẫu xin nghỉ phép có lương trên màn Hôm nay (/my-day): từ ngày → đến ngày trong MỘT đơn, lý do không bắt buộc.
// Máy chủ (request_paid_leave_range) bỏ Chủ nhật và ngày lễ của công ty, giữ ngày đã có đơn và từ chối cả đơn khi số dư
// không đủ — câu lỗi của máy chủ hiện ngay dưới nút gửi. Xem trước đọc cùng lịch ngày làm với máy chủ (vn_workdays);
// số dư / hôm nay lấy từ get_my_day_summary (props), không tự tính lại số dư.
import { useRef, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { leaveRequestErrorMessage, useLeaveWorkdays, useRequestLeaveRange } from "@/hooks/useMyDay";
import { focusFirstError } from "@/lib/formErrors";
import {
  calendarDaysBetween, leaveDateSpan, leaveDaysLabel, leaveRequestSchema, leaveWorkDays,
  MAX_LEAVE_RANGE_DAYS, type LeaveRequestValues,
} from "@/lib/leaveDates";

export function LeaveRequestForm({ today, left, disabled = false, onDone }: {
  /** Hôm nay theo máy chủ (YYYY-MM-DD). */
  today: string;
  /** Số ngày phép còn lại tính đến tháng này (get_my_day_summary.leave.left). */
  left: number;
  disabled?: boolean;
  onDone: () => void;
}) {
  const requestLeave = useRequestLeaveRange();
  const root = useRef<HTMLDivElement>(null);
  const [serverError, setServerError] = useState("");
  const form = useForm<LeaveRequestValues>({
    shouldFocusError: false,
    resolver: zodResolver(leaveRequestSchema(today)) as Resolver<LeaveRequestValues>,
    defaultValues: { from: "", to: "", reason: "" },
  });
  const { errors } = form.formState;
  const from = form.watch("from");
  const to = form.watch("to") || from;
  const span = from ? calendarDaysBetween(from, to) : 0;
  const inRange = span > 0 && span <= MAX_LEAVE_RANGE_DAYS;
  const notSunday = inRange ? leaveWorkDays(from, to) : [];
  // Lịch ngày làm của công ty (vn_workdays — cùng nguồn máy chủ dùng): chưa đọc xong / lỗi thì xem trước chỉ bỏ Chủ nhật.
  const calendar = useLeaveWorkdays(inRange ? from : "", inRange ? to : "");
  const workdays = calendar.data ? new Set(calendar.data) : null;
  const days = workdays ? notSunday.filter((day) => workdays.has(day)) : notSunday;
  const holidays = workdays ? notSunday.filter((day) => !workdays.has(day)) : [];
  const skipped = [notSunday.length < span ? "Chủ nhật" : null, holidays.length > 0 ? `ngày lễ ${leaveDateSpan(holidays)}` : null]
    .filter(Boolean).join(", ");

  const submit = form.handleSubmit(async (values) => {
    setServerError("");
    try {
      const result = await requestLeave.mutateAsync({ from: values.from, to: values.to || values.from, reason: values.reason });
      if (result.requested.length > 0) {
        const kept = result.existing.length > 0 ? ` Ngày ${leaveDateSpan(result.existing)} đã có đơn từ trước nên giữ nguyên.` : "";
        const off = result.holidays.length > 0 ? ` Ngày lễ ${leaveDateSpan(result.holidays)} không tính.` : "";
        toast.success(`Đã gửi đơn nghỉ ${leaveDaysLabel(result.requested)}. Đơn đang chờ duyệt, ngày công chưa được xác nhận.${kept}${off}`);
      } else {
        toast.info(`Ngày ${leaveDateSpan(result.existing)} đã có đơn nghỉ từ trước — không gửi thêm.`);
      }
      form.reset();
      onDone();
    } catch (error) {
      setServerError(leaveRequestErrorMessage(error));
    }
  }, (formErrors) => void focusFirstError(formErrors, { root: root.current, order: ["from", "to", "reason"] }));

  const fromField = form.register("from", {
    onChange: (event: { target: { value: string } }) => {
      // Chọn ngày bắt đầu: "Đến ngày" trống hoặc đang trước ngày đó thì kéo theo — mặc định là nghỉ một ngày.
      const value = event.target.value;
      const current = form.getValues("to");
      if (value && (!current || current < value)) form.setValue("to", value, { shouldValidate: form.formState.isSubmitted });
    },
  });

  return (
    <div ref={root} className="mb-3 rounded-xl border bg-white p-3 shadow-sm">
      <div className="mb-2 text-sm font-medium">Xin nghỉ phép có lương</div>
      <form className="space-y-2" noValidate onSubmit={(event) => void submit(event)}>
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="leave-from" className="text-xs">Từ ngày</Label>
            <Input id="leave-from" type="date" min={today} className="h-9 px-2 text-sm"
              aria-invalid={!!errors.from} aria-describedby={errors.from ? "leave-from-error" : undefined} {...fromField} />
            {errors.from && <p id="leave-from-error" role="alert" className="text-xs text-destructive">{errors.from.message}</p>}
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="leave-to" className="text-xs">Đến ngày</Label>
            <Input id="leave-to" type="date" min={from || today} className="h-9 px-2 text-sm"
              aria-invalid={!!errors.to} aria-describedby={errors.to ? "leave-to-error" : undefined} {...form.register("to")} />
            {errors.to && <p id="leave-to-error" role="alert" className="text-xs text-destructive">{errors.to.message}</p>}
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="leave-reason" className="text-xs">Lý do <span className="font-normal text-slate-400">(không bắt buộc)</span></Label>
          <Input id="leave-reason" maxLength={500} placeholder="Ví dụ: về quê" className="h-9 text-sm"
            aria-invalid={!!errors.reason} aria-describedby={errors.reason ? "leave-reason-error" : undefined} {...form.register("reason")} />
          {errors.reason && <p id="leave-reason-error" role="alert" className="text-xs text-destructive">{errors.reason.message}</p>}
        </div>
        <p className="text-xs text-slate-600" aria-live="polite">
          {!inRange || notSunday.length === 0
            ? <>Nghỉ một ngày thì chọn cùng một ngày ở hai ô. Số dư phép hiện còn {left} ngày.</>
            : days.length === 0
              ? <>Các ngày đã chọn đều là Chủ nhật hoặc ngày lễ của công ty — không cần xin phép.</>
              : <>Đơn gồm <span className="font-medium text-slate-800">{leaveDaysLabel(days)}</span>{skipped ? ` (${skipped} không tính)` : ""}. Số dư phép hiện còn {left} ngày.</>}
          {inRange && calendar.isError ? " Chưa đọc được lịch nghỉ lễ của công ty — ngày lễ (nếu có) vẫn không tính khi gửi." : ""}
        </p>
        {serverError && <p role="alert" className="text-sm text-destructive">{serverError}</p>}
        <Button type="submit" size="sm" className="w-full" disabled={disabled || requestLeave.isPending}>
          {requestLeave.isPending ? "Đang gửi…" : workdays && days.length > 1 ? `Gửi đơn ${days.length} ngày` : "Gửi đơn"}
        </Button>
      </form>
      <p className="mt-1.5 text-[11px] text-slate-500">
        Ngày phép là ngày trung tính: chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh — bạn không thiệt.
      </p>
    </div>
  );
}
