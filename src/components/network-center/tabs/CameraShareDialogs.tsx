import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, Loader2, MessageSquareText, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useCreateCameraShare, type CameraShareScope } from "@/hooks/network-center/useCameraShares";
import { cameraTimeLabel } from "@/lib/network-center/cameraArchive";
import type { CameraRecorder } from "@/lib/network-center/cameraContracts";
import {
  CAMERA_SHARE_EXPIRY, CAMERA_SHARE_NOTE_MAX, CameraShareError, cameraShareChannelLabel, cameraShareCreateInput,
  cameraShareExpiryHours, cameraShareExpiryLabel, cameraShareFormSchema, cameraShareLink, cameraShareMessage,
  cameraShareWindow, cameraShareWindowLabel, defaultCameraShareValues, recorderChannelName,
  type CameraShareCreated, type CameraShareFormValues,
} from "@/lib/network-center/cameraShare";
import { focusFirstError } from "@/lib/formErrors";
import { cn } from "@/lib/utils";

const shareSelectClass = "flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50";

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const UNKNOWN_CREATE = "Chưa rõ đã tạo lượt chia sẻ chưa — mạng không phản hồi kịp. Xem danh sách bên dưới trước khi tạo lại.";

export function CreateCameraShareDialog({ open, onOpenChange, recorder, scope, onCreated }: {
  open: boolean; onOpenChange(open: boolean): void; recorder: CameraRecorder; scope: CameraShareScope; onCreated(result: CameraShareCreated): void;
}) {
  const channels = useMemo(() => Array.from({ length: recorder.channel_count }, (_, index) => index + 1), [recorder.channel_count]);
  const firstChannel = channels[0] ?? 1;
  const create = useCreateCameraShare(scope);
  const schema = useMemo(() => cameraShareFormSchema(() => Date.now()), []);
  const form = useForm<CameraShareFormValues>({ resolver: zodResolver(schema), defaultValues: defaultCameraShareValues(Date.now(), firstChannel) });
  const { reset } = form;
  const resetMutation = create.reset;
  useEffect(() => {
    if (!open) return;
    reset(defaultCameraShareValues(Date.now(), firstChannel));
    resetMutation();
  }, [open, reset, resetMutation, firstChannel]);

  const values = form.watch();
  const preview = cameraShareWindow(values.from, values.to, Date.now());
  const busy = form.formState.isSubmitting || create.isPending;
  const submit = form.handleSubmit(async (data) => {
    form.clearErrors("root.server");
    try {
      const result = await create.mutateAsync(cameraShareCreateInput(recorder.id, data, Date.now()));
      // Mật khẩu chỉ còn ở state của hộp kết quả — bỏ khỏi observer của mutation ngay.
      resetMutation();
      onCreated(result);
      onOpenChange(false);
    } catch (error) {
      form.setError("root.server", {
        message: error instanceof CameraShareError ? (error.kind === "network" ? UNKNOWN_CREATE : error.message) : "Chưa tạo được lượt chia sẻ. Vui lòng thử lại.",
      });
    }
  }, (errors) => { void focusFirstError(errors); });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[92vh] max-w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chia sẻ camera cho khách</DialogTitle>
          <DialogDescription>{recorder.display_name}. Khách chỉ xem lại được một kênh trong khung giờ đã chọn, không xem trực tiếp, không tải video.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(event) => { void submit(event); }} className="space-y-4" noValidate>
            <FormField control={form.control} name="channel" render={({ field }) => (
              <FormItem>
                <FormLabel>Kênh</FormLabel>
                <FormControl>
                  <select className={shareSelectClass} disabled={busy} name={field.name} ref={field.ref} onBlur={field.onBlur} value={field.value} onChange={(event) => field.onChange(Number(event.target.value))}>
                    {channels.map((value) => <option key={value} value={value}>{cameraShareChannelLabel(value, recorderChannelName(recorder, value))}</option>)}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField control={form.control} name="from" rules={{ deps: ["to"] }} render={({ field }) => (
                <FormItem>
                  <FormLabel>Xem lại từ</FormLabel>
                  <FormControl><Input {...field} type="datetime-local" step="1" disabled={busy} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="to" rules={{ deps: ["from"] }} render={({ field }) => (
                <FormItem>
                  <FormLabel>Đến</FormLabel>
                  <FormControl><Input {...field} type="datetime-local" step="1" disabled={busy} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <p className="text-xs text-muted-foreground sm:col-span-2">Giờ Việt Nam (UTC+7). Tối đa 24 giờ, cả khung giờ phải ở quá khứ (khách chỉ xem lại).</p>
            </div>
            {preview.ok
              ? <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">Khách xem lại được: {cameraShareWindowLabel(preview.start, preview.end)}</p>
              : <p className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">Khung giờ chưa hợp lệ: {preview.message}</p>}
            <FormField control={form.control} name="expiry" render={({ field }) => (
              <FormItem>
                <FormLabel>Hiệu lực của link</FormLabel>
                <div role="radiogroup" aria-label="Hiệu lực của link" className="flex flex-wrap gap-1.5">
                  {CAMERA_SHARE_EXPIRY.map((option) => (
                    <button key={option} type="button" role="radio" aria-checked={field.value === option} disabled={busy} onClick={() => field.onChange(option)}
                      className={cn("h-11 rounded-full border px-4 text-sm transition-colors disabled:opacity-50", field.value === option ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted")}>
                      {cameraShareExpiryLabel[option]}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Link tự hết hạn lúc khoảng {cameraTimeLabel(Date.now() + cameraShareExpiryHours[field.value] * 3600_000)}; thu hồi tay được bất cứ lúc nào.</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="note" render={({ field }) => (
              <FormItem>
                <FormLabel>Ghi chú (không bắt buộc)</FormLabel>
                <FormControl><Input {...field} maxLength={CAMERA_SHARE_NOTE_MAX} placeholder="Tên khách / phòng, ví dụ: Chị Lan P302" autoComplete="off" disabled={busy} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            {form.formState.errors.root?.server?.message && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{form.formState.errors.root.server.message}</p>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Huỷ</Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Share2 className="mr-2 h-4 w-4" aria-hidden="true" />}
                Tạo link chia sẻ
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

type Copied = "link" | "code" | "password" | "message" | "failed";
const copiedLabel: Record<Exclude<Copied, "failed">, string> = { link: "Đã sao chép link.", code: "Đã sao chép ID.", password: "Đã sao chép mật khẩu.", message: "Đã sao chép tin nhắn gửi khách." };

/**
 * Hộp hiện ID + mật khẩu vừa tạo. Mật khẩu chỉ sống trong props của hộp này (state của panel xoá khi đóng):
 * không ghi bộ nhớ trình duyệt, không vào bộ đệm query, không log.
 */
export function CameraShareResultDialog({ result, recorder, buildingName, onClose }: {
  result: CameraShareCreated | null; recorder: CameraRecorder; buildingName: string; onClose(): void;
}) {
  const [copied, setCopied] = useState<Copied | null>(null);
  useEffect(() => setCopied(null), [result]);
  if (!result) return null;
  const link = cameraShareLink(window.location.origin, result.code);
  const cameraLabel = cameraShareChannelLabel(result.channel, result.channel_name ?? recorderChannelName(recorder, result.channel));
  const message = cameraShareMessage({
    link, code: result.code, password: result.password, cameraLabel, buildingName,
    windowStart: result.window_start, windowEnd: result.window_end, expiresAt: result.expires_at,
  });
  const copy = async (what: Exclude<Copied, "failed">, text: string) => setCopied(await copyText(text) ? what : "failed");
  const rows: Array<{ key: "link" | "code" | "password"; label: string; value: string; mono?: boolean }> = [
    { key: "link", label: "Link xem", value: link },
    { key: "code", label: "ID", value: result.code, mono: true },
    { key: "password", label: "Mật khẩu", value: result.password, mono: true },
  ];
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[92vh] max-w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Đã tạo link chia sẻ camera</DialogTitle>
          <DialogDescription>{cameraLabel} · xem lại {cameraShareWindowLabel(result.window_start, result.window_end)} · hết hạn lúc {cameraTimeLabel(result.expires_at)}.</DialogDescription>
        </DialogHeader>
        <dl className="space-y-3">
          {rows.map((row) => (
            <div key={row.key} className="space-y-1">
              <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
              <dd className="flex items-center gap-2">
                <span aria-label={row.label} className={cn("min-w-0 flex-1 select-all break-all rounded-md border bg-muted/40 px-3 py-2", row.mono ? "font-mono text-xl font-bold tracking-[0.2em]" : "text-sm")}>{row.value}</span>
                <Button type="button" variant="outline" size="icon" className="h-11 w-11 shrink-0" aria-label={`Sao chép ${row.label === "ID" ? "ID" : row.label.toLowerCase()}`} onClick={() => void copy(row.key, row.value)}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </Button>
              </dd>
            </div>
          ))}
        </dl>
        <p role="note" className="rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="font-semibold">Mật khẩu chỉ hiện một lần.</span> CRM không lưu mật khẩu — sao chép hoặc gửi cho khách trước khi đóng. Quên mật khẩu thì thu hồi rồi tạo lượt mới.
        </p>
        <Button type="button" className="w-full" onClick={() => void copy("message", message)}>
          <MessageSquareText className="mr-2 h-4 w-4" aria-hidden="true" />Sao chép tin nhắn gửi khách
        </Button>
        {copied && copied !== "failed" && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{copiedLabel[copied]}</p>}
        {copied === "failed" && <p role="alert" className="text-sm text-destructive">Trình duyệt không cho sao chép — hãy ghi lại ID và mật khẩu.</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Đã gửi cho khách</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
