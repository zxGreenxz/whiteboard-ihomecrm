import { zodResolver } from "@hookform/resolvers/zod";
import { Bell, BellOff, CalendarClock, Eye, EyeOff, Wrench } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  addDaysIso, cameraAlertFailure, cameraChannelMuteText, cameraChannelMuteSchema, formatVnDate, SNOOZE_MAX_DAYS,
  snoozeUntilIso, vnIsoDay, type CameraChannelMuteFormValues,
} from "@/lib/network-center/cameraAlertForm";
import type { CameraBuildingMutes, CameraChannelMuteInput, CameraChannelMuteKind } from "@/lib/network-center/cameraContracts";

export type CameraChannelMute = CameraBuildingMutes["items"][number];

const KIND_COPY: Record<CameraChannelMuteKind, { title: string; description: string; submit: string }> = {
  IGNORE: {
    title: "Không theo dõi kênh này",
    description: "Hệ thống bỏ hẳn kênh này: không báo, không mở sự cố, không đưa vào bản tin. Sự cố đang mở của kênh sẽ được đóng. Hợp với kênh chưa lắp camera.",
    submit: "Không theo dõi",
  },
  SNOOZE: {
    title: "Tạm ẩn kênh này",
    description: "Giống “Không theo dõi” cho đến hết ngày đã chọn, sau đó hệ thống tự theo dõi lại.",
    submit: "Tạm ẩn",
  },
  KNOWN_BROKEN: {
    title: "Đánh dấu kênh đã biết hỏng",
    description: "Vẫn theo dõi nhưng không gửi tin riêng khi kênh mất hay có lại. Kênh chỉ được nhắc trong bản tin sáng thứ Hai cho đến khi có hình lại; có hình lại thì tự bỏ dấu.",
    submit: "Đã biết hỏng",
  },
};

/** Badge trạng thái tắt báo của một kênh, kèm người đặt và ngày đặt. */
export function CameraChannelMuteBadge({ mute }: { mute: CameraChannelMute }) {
  const who = mute.setByName ?? "Không rõ người đặt";
  return (
    <div className="nc-channel-mute" data-mute-kind={mute.kind}>
      <span className={`nc-status ${mute.kind === "KNOWN_BROKEN" ? "nc-status-warn" : "nc-status-neutral"}`}>
        {mute.kind === "KNOWN_BROKEN" ? <Wrench className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" /> : <BellOff className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />}
        {cameraChannelMuteText(mute)}
      </span>
      <small>{who} đặt ngày {formatVnDate(mute.setAt)}</small>
      {mute.note ? <small className="nc-channel-mute-note">Ghi chú: {mute.note}</small> : null}
    </div>
  );
}

interface CameraChannelAlertMenuProps {
  recorderId: string;
  channel: number;
  channelLabel: string;
  mute?: CameraChannelMute;
  isDemo: boolean;
  onSet: (input: CameraChannelMuteInput) => Promise<unknown>;
  onClear: () => Promise<unknown>;
}

/** Menu "báo kênh" — chỉ dựng khi người xem sửa được (chủ công ty hoặc superadmin). */
export function CameraChannelAlertMenu({ recorderId, channel, channelLabel, mute, isDemo, onSet, onClear }: CameraChannelAlertMenuProps) {
  const [kind, setKind] = useState<CameraChannelMuteKind | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const choose = (next: CameraChannelMuteKind) => { setMenuOpen(false); setKind(next); };
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  // Đóng hộp / xong "Theo dõi lại" thì trả focus về nút "Báo kênh" (không để rơi về đầu trang).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const focusTrigger = () => setTimeout(() => triggerRef.current?.focus(), 0);

  const clear = async () => {
    if (clearing) return;
    setError("");
    setClearing(true);
    try {
      await onClear();
    } catch (caught) {
      setError(cameraAlertFailure(caught, "theo dõi lại kênh").text);
    } finally {
      setClearing(false);
      focusTrigger();
    }
  };

  return (
    <div className="nc-channel-menu">
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button ref={triggerRef} type="button" variant="outline" size="sm" disabled={clearing} aria-label={`Báo kênh: ${channelLabel}`}>
            <Bell className="mr-1 h-4 w-4" aria-hidden="true" />Báo kênh
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" collisionPadding={8} aria-label={`Cách báo cho ${channelLabel}`} className="network-center nc-select-content nc-menu-content">
          <div role="group" aria-label={`Cách báo cho ${channelLabel}`} className="nc-menu-list">
            <p className="nc-menu-title">{channelLabel}</p>
            <button type="button" onClick={() => choose("IGNORE")}><EyeOff className="mr-2 h-4 w-4" aria-hidden="true" />Không theo dõi kênh này</button>
            <button type="button" onClick={() => choose("SNOOZE")}><CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" />Tạm ẩn đến…</button>
            <button type="button" onClick={() => choose("KNOWN_BROKEN")}><Wrench className="mr-2 h-4 w-4" aria-hidden="true" />Đã biết hỏng (nhắc hằng tuần)</button>
            {mute ? <button type="button" onClick={() => { setMenuOpen(false); void clear(); }}><Eye className="mr-2 h-4 w-4" aria-hidden="true" />Theo dõi lại</button> : null}
          </div>
        </PopoverContent>
      </Popover>
      {error ? <p className="nc-form-error" role="alert">{error}</p> : null}
      {kind ? (
        <CameraChannelMuteDialog
          key={kind}
          kind={kind}
          channelLabel={channelLabel}
          current={mute}
          isDemo={isDemo}
          onClose={() => { setKind(null); focusTrigger(); }}
          onSubmit={(values) => onSet({
            recorderId, channel, kind: values.kind,
            untilAt: values.kind === "SNOOZE" ? snoozeUntilIso(values.untilDay) : null,
            note: values.note,
          })}
        />
      ) : null}
    </div>
  );
}

function CameraChannelMuteDialog({ kind, channelLabel, current, isDemo, onClose, onSubmit }: {
  kind: CameraChannelMuteKind;
  channelLabel: string;
  current?: CameraChannelMute;
  isDemo: boolean;
  onClose: () => void;
  onSubmit: (values: CameraChannelMuteFormValues) => Promise<unknown>;
}) {
  const today = useMemo(() => vnIsoDay(Date.now()), []);
  const schema = useMemo(() => cameraChannelMuteSchema(today), [today]);
  const form = useForm<CameraChannelMuteFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind,
      untilDay: kind === "SNOOZE" ? (current?.kind === "SNOOZE" && current.untilAt ? vnIsoDay(Date.parse(current.untilAt)) : addDaysIso(today, 7)) : "",
      note: current?.note ?? "",
    },
  });
  const copy = KIND_COPY[kind];
  const submitting = form.formState.isSubmitting;

  const submit = form.handleSubmit(async (values) => {
    form.clearErrors("root.server");
    try {
      await onSubmit(values);
      onClose();
    } catch (caught) {
      form.setError("root.server", { type: "server", message: cameraAlertFailure(caught, "lưu cách báo của kênh").text });
    }
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="network-center network-center-dialog nc-dialog nc-dialog-fit">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{channelLabel}. {copy.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form noValidate className="nc-form" onSubmit={(event) => void submit(event)}>
            <fieldset disabled={submitting} className="nc-form">
              {kind === "SNOOZE" ? (
                <FormField control={form.control} name="untilDay" render={({ field }) => (
                  <FormItem className="nc-field">
                    <FormLabel>Tạm ẩn đến hết ngày</FormLabel>
                    <FormControl><DateInput value={field.value} onChange={field.onChange} onBlur={field.onBlur} name={field.name} /></FormControl>
                    <FormDescription>Tối đa {SNOOZE_MAX_DAYS + 1} ngày. Sau ngày này hệ thống tự theo dõi lại.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )} />
              ) : null}
              <FormField control={form.control} name="note" render={({ field }) => (
                <FormItem className="nc-field">
                  <FormLabel>Ghi chú (không bắt buộc)</FormLabel>
                  <FormControl><Textarea {...field} rows={3} placeholder="Ví dụ: chưa lắp camera, chờ thợ thay dây" /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </fieldset>
            {isDemo ? <p className="nc-footnote">Dữ liệu mô phỏng: chỉ lưu trong trình duyệt này.</p> : null}
            {form.formState.errors.root?.server?.message ? <p className="nc-form-error" role="alert">{form.formState.errors.root.server.message}</p> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={onClose}>Huỷ</Button>
              <Button type="submit" disabled={submitting}>{submitting ? "Đang lưu…" : copy.submit}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
