import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Lock, MessageCircle, MoonStar, RotateCcw, Save, Send } from "lucide-react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { useEffect, useState } from "react";
import { useForm, useWatch, type Control } from "react-hook-form";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { CameraAlertScope } from "@/hooks/network-center/useCameraAlerts";
import { focusFirstError } from "@/lib/formErrors";
import {
  buildCameraAlertPatch, CAMERA_ALERT_DELIVERY_LABELS, CAMERA_ALERT_SEVERITY_LABELS, CAMERA_ALERT_TYPE_INFO, cameraAlertFailure,
  cameraAlertFormSchema, cameraAlertFormValues, deliveryOptionsFor, FLAPPING_CODE, startsLiveSending, testResultText,
  type CameraAlertFailureKind, type CameraAlertFormValues, type CameraAlertTone,
} from "@/lib/network-center/cameraAlertForm";
import {
  CAMERA_ALERT_TYPE_CODES,
  type CameraAlertRepository, type CameraAlertSettingsPatch, type CameraAlertSettingsView, type CameraAlertTestResult, type CameraAlertTypeCode,
} from "@/lib/network-center/cameraContracts";
import { CameraAlertZaloPicker, type CameraAlertZaloGroup } from "./CameraAlertZaloPicker";

const ZALO_WARNINGS: Record<NonNullable<CameraAlertSettingsView["zalo"]["warning"]>, (view: CameraAlertSettingsView) => string> = {
  NOT_CONFIGURED: () => "Chưa chọn nhóm Zalo nhận cảnh báo. Khi chưa có nhóm, cảnh báo chỉ hiện ở chuông CRM.",
  GROUP_MISSING: () => "Nhóm Zalo đã chọn không còn (nick đã rời nhóm, nhóm bị xoá hoặc không thuộc nick đã chọn). Chọn lại nhóm.",
  ACCOUNT_DISCONNECTED: (view) => `Nick Zalo ${view.zalo.account ? `“${view.zalo.account.name}” ` : ""}đang mất kết nối — tin Zalo sẽ không gửi được. Vào Chat Zalo để kết nối lại nick.`,
};

interface Feedback { kind: CameraAlertFailureKind | "info"; text: string; tone?: CameraAlertTone }

export function CameraAlertSettingsForm({ view, scope, repository, isDemo, onSave, onTest, onReload, onDirtyChange, reloading }: {
  view: CameraAlertSettingsView;
  /** Báo cho trang biết form đang có thay đổi chưa lưu (để không dựng lại form dưới tay người dùng). */
  onDirtyChange?: (dirty: boolean) => void;
  scope: CameraAlertScope;
  repository?: CameraAlertRepository;
  isDemo: boolean;
  onSave: (expectedVersion: number, patch: CameraAlertSettingsPatch) => Promise<CameraAlertSettingsView>;
  onTest: () => Promise<CameraAlertTestResult>;
  onReload: () => void;
  reloading: boolean;
}) {
  const locked = !view.canEdit;
  const form = useForm<CameraAlertFormValues>({
    resolver: zodResolver(cameraAlertFormSchema),
    defaultValues: cameraAlertFormValues(view.settings, view.defaults),
  });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmLive, setConfirmLive] = useState<CameraAlertSettingsPatch | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<CameraAlertZaloGroup | null>(null);
  const [testing, setTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{ tone: CameraAlertTone; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = form.formState.isSubmitting || busy;
  const disabled = locked || saving;
  const [enabled, mode, conversationId, accountId] = useWatch({ control: form.control, name: ["enabled", "mode", "zaloConversationId", "zaloAccountId"] });
  const zaloDirty = conversationId !== view.settings.zaloConversationId || accountId !== view.settings.zaloAccountId;
  const isDirty = form.formState.isDirty;
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  // Nơi nhận đã lưu đang hỏng (nick mất kết nối / nhóm không còn) mà chưa đổi nhóm:
  // tin hiện trạng chỉ gửi MỘT lần nên không cho bật gửi thật lúc này.
  const liveBlockedBy = !zaloDirty && (view.zalo.warning === "ACCOUNT_DISCONNECTED" || view.zalo.warning === "GROUP_MISSING")
    ? ZALO_WARNINGS[view.zalo.warning](view) : null;

  const groupName = picked && picked.id === conversationId ? picked.name
    : view.zalo.conversation && view.zalo.conversation.id === conversationId ? view.zalo.conversation.name : null;
  const accountName = picked && picked.id === conversationId ? picked.accountName
    : view.zalo.account && view.zalo.account.id === accountId ? view.zalo.account.name : null;

  const save = async (patch: CameraAlertSettingsPatch) => {
    setBusy(true);
    try {
      await onSave(view.settings.version, patch);
      // Thành công: trang dựng lại form theo phiên bản mới (key theo version).
    } catch (caught) {
      setFeedback(cameraAlertFailure(caught, "lưu cài đặt cảnh báo camera"));
    } finally {
      setBusy(false);
    }
  };

  const submit = form.handleSubmit(async (values) => {
    setFeedback(null);
    const patch = buildCameraAlertPatch(view.settings, values, view.defaults);
    if (Object.keys(patch).length === 0) {
      setFeedback({ kind: "info", text: "Chưa có thay đổi nào để lưu." });
      return;
    }
    if (startsLiveSending(view.settings, values)) {
      setConfirmLive(patch);
      return;
    }
    await save(patch);
  }, (errors) => { void focusFirstError(errors); });

  const sendTest = async () => {
    if (testing) return;
    setTestFeedback(null);
    setTesting(true);
    try {
      setTestFeedback(testResultText(await onTest()));
    } catch (caught) {
      setTestFeedback({ tone: "bad", text: cameraAlertFailure(caught, "gửi tin thử").text });
    } finally {
      setTesting(false);
    }
  };

  const status = !view.settings.enabled ? { label: "Đang tắt", tone: "neutral" }
    : view.settings.mode === "LIVE" ? { label: "Đang gửi thật", tone: "good" } : { label: "Chạy thử (không gửi)", tone: "info" };

  return (
    <Form {...form}>
      <form noValidate className="nc-alert-form" onSubmit={(event) => void submit(event)} aria-label="Cài đặt cảnh báo camera">
        {locked ? (
          <p className="nc-locked-note nc-display-note" role="note"><Lock aria-hidden="true" />Chỉ chủ công ty hoặc superadmin sửa được. Bạn đang xem ở chế độ chỉ đọc.</p>
        ) : null}
        {isDemo ? <p className="nc-locked-note nc-display-note">Dữ liệu mô phỏng: lưu và gửi tin thử chỉ chạy trong bộ nhớ trình duyệt, không gửi Zalo thật.</p> : null}

        <section className="nc-panel" aria-labelledby="camera-alert-power-title">
          <div className="nc-panel-heading">
            <div><p className="nc-eyebrow">Trạng thái hiện tại · <span className={`nc-status nc-status-${status.tone}`}>{status.label}</span></p><h3 id="camera-alert-power-title">Bật cảnh báo</h3></div>
          </div>
          <div className="nc-alert-section">
            <FormField control={form.control} name="enabled" render={({ field }) => (
              <FormItem className="nc-setting-switch">
                <div>
                  <FormLabel>Bật cảnh báo camera cho cả công ty</FormLabel>
                  <FormDescription>Tắt thì không gửi gì, kể cả chuông CRM.</FormDescription>
                </div>
                <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} disabled={disabled} /></FormControl>
              </FormItem>
            )} />
            <FormField control={form.control} name="mode" render={({ field }) => (
              <FormItem>
                <p id="camera-alert-mode-label" className="text-sm font-medium">Chế độ</p>
                {/* Radix RadioGroup (nền của shadcn radio-group): phím mũi tên + một điểm tab. Thẻ lớn tự dựng vì nút tròn của
                    shadcn bị luật nút 44 px của Trung tâm mạng kéo méo. */}
                <RadioGroupPrimitive.Root value={field.value} onValueChange={field.onChange} disabled={disabled}
                  aria-labelledby="camera-alert-mode-label" className="nc-mode-options">
                  <RadioGroupPrimitive.Item value="SHADOW" className="nc-mode-option">
                    <strong>Chạy thử (không gửi)</strong>
                    <span>Chỉ ghi vào Nhật ký gửi “lẽ ra sẽ gửi gì”. Không gửi Zalo, không báo chuông.</span>
                  </RadioGroupPrimitive.Item>
                  <RadioGroupPrimitive.Item value="LIVE" className="nc-mode-option">
                    <strong>Gửi thật</strong>
                    <span>Gửi Zalo vào nhóm đã chọn và báo chuông CRM. Khi bật sẽ gửi một tin hiện trạng.</span>
                  </RadioGroupPrimitive.Item>
                </RadioGroupPrimitive.Root>
                <FormMessage />
              </FormItem>
            )} />
            <p className="nc-today" role="status">
              Hôm nay đã gửi <strong>{view.today.zaloSent}/{view.today.cap}</strong> tin Zalo.
              {view.settings.mode === "SHADOW" && view.settings.enabled ? <> Chạy thử: lẽ ra gửi <strong>{view.today.shadowWouldSend}</strong> tin.</> : null}
            </p>
          </div>
        </section>

        <section className="nc-panel" aria-labelledby="camera-alert-zalo-title">
          <div className="nc-panel-heading">
            <div><p className="nc-eyebrow">Nơi nhận</p><h3 id="camera-alert-zalo-title">Nhóm Zalo</h3></div>
          </div>
          <div className="nc-alert-section">
            <div className="nc-zalo-target">
              <span><MessageCircle className="mr-1 inline h-4 w-4" aria-hidden="true" />Nhóm: <strong>{groupName ?? (conversationId ? "Nhóm đã chọn" : "Chưa chọn")}</strong></span>
              <span>Nick gửi: <strong>{accountName ?? (accountId ? "Nick đã chọn" : "Chưa chọn")}</strong></span>
            </div>
            {view.zalo.warning && !zaloDirty ? (
              <p className="nc-locked-note nc-display-note" role="alert"><AlertTriangle aria-hidden="true" />{ZALO_WARNINGS[view.zalo.warning](view)}</p>
            ) : null}
            {zaloDirty ? <p className="nc-locked-note nc-display-note" role="status">Đã chọn nhóm mới — bấm “Lưu cài đặt” để áp dụng. Tin thử gửi vào nhóm đã lưu.</p> : null}
            <FormField control={form.control} name="zaloConversationId" render={() => <FormItem><FormMessage /></FormItem>} />
            <div className="nc-heading-actions nc-zalo-actions">
              <Button type="button" variant="outline" disabled={disabled} onClick={() => setPickerOpen(true)}><MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />{conversationId ? "Đổi nhóm…" : "Chọn nhóm…"}</Button>
              <Button type="button" variant="outline" disabled={disabled || testing || zaloDirty || !view.settings.zaloConversationId} onClick={() => void sendTest()}>
                <Send className="mr-2 h-4 w-4" aria-hidden="true" />{testing ? "Đang gửi…" : "Gửi tin thử"}
              </Button>
            </div>
            <p className="nc-hint">Tin thử: “Tin thử cảnh báo camera — nếu nhóm nhận được tin này là cấu hình đúng.” Tin thử luôn gửi thật vào nhóm đã lưu, kể cả khi đang chạy thử, và tính vào trần tin mỗi ngày.</p>
            {testFeedback ? <p className={`nc-inline-feedback nc-tone-${testFeedback.tone}`} role="status">{testFeedback.text}</p> : null}
          </div>
        </section>

        <section className="nc-panel" aria-labelledby="camera-alert-types-title">
          <div className="nc-panel-heading">
            <div><p className="nc-eyebrow">Chọn loại cần báo</p><h3 id="camera-alert-types-title">Loại sự cố</h3></div>
          </div>
          <p className="nc-log-intro">“Zalo” gửi vào nhóm và báo chuông. “Chỉ bản tin sáng” gom vào tin {view.settings.digestAt}. “Chỉ chuông” chỉ báo trong CRM. Ngưỡng là thời gian sự cố kéo dài trước khi báo.</p>
          <div className="nc-alert-types">
            {CAMERA_ALERT_TYPE_CODES.map((code) => <AlertTypeRow key={code} code={code} control={form.control} disabled={disabled} />)}
          </div>
        </section>

        <section className="nc-panel" aria-labelledby="camera-alert-time-title">
          <div className="nc-panel-heading">
            <div><p className="nc-eyebrow">Giờ và giới hạn</p><h3 id="camera-alert-time-title"><MoonStar className="mr-2 inline h-5 w-5" aria-hidden="true" />Giờ đêm, bản tin, trần tin</h3></div>
          </div>
          <p className="nc-log-intro">Ban đêm chỉ sự cố nghiêm trọng gửi ngay; kênh mất phát sinh ban đêm dồn vào tin lúc hết giờ đêm.</p>
          <div className="nc-settings-grid">
            <ClockField control={form.control} name="nightStart" label="Giờ đêm bắt đầu" disabled={disabled} />
            <ClockField control={form.control} name="nightEnd" label="Giờ đêm kết thúc (gửi tin dồn)" disabled={disabled} />
            <ClockField control={form.control} name="digestAt" label="Giờ bản tin sáng (nhắc sự cố chưa xử lý)" disabled={disabled} />
            <FormField control={form.control} name="dailyZaloCap" render={({ field }) => (
              <FormItem className="nc-field">
                <FormLabel>Tối đa tin Zalo mỗi ngày</FormLabel>
                <FormControl>
                  <Input type="number" inputMode="numeric" min={1} max={20} step={1} disabled={disabled} name={field.name} ref={field.ref} onBlur={field.onBlur}
                    value={Number.isFinite(field.value) ? field.value : ""} onChange={(event) => field.onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} />
                </FormControl>
                <FormDescription>Từ 1 đến 20. Vượt trần thì dồn vào bản tin kế tiếp; chuông vẫn báo.</FormDescription>
                <FormMessage />
              </FormItem>
            )} />
          </div>
        </section>

        {!locked ? (
          <div className="nc-save-bar">
            <div className="min-w-0 flex-1">
              {feedback ? (
                <div className={feedback.kind === "info" ? "nc-inline-feedback nc-tone-info" : "nc-form-error"} role={feedback.kind === "info" ? "status" : "alert"}>
                  <p>{feedback.text}</p>
                  {feedback.kind === "conflict" ? (
                    <Button type="button" variant="outline" className="mt-2" disabled={reloading} onClick={onReload}><RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />{reloading ? "Đang tải lại…" : "Tải lại"}</Button>
                  ) : null}
                </div>
              ) : <p className="nc-hint">{form.formState.isDirty ? "Có thay đổi chưa lưu." : "Không có thay đổi chưa lưu."}</p>}
            </div>
            <div className="nc-heading-actions">
              <Button type="button" variant="outline" disabled={saving || !form.formState.isDirty} onClick={() => { form.reset(); setPicked(null); setFeedback(null); }}>Bỏ thay đổi</Button>
              <Button type="submit" disabled={saving}><Save className="mr-2 h-4 w-4" aria-hidden="true" />{saving ? "Đang lưu…" : "Lưu cài đặt"}</Button>
            </div>
          </div>
        ) : null}

        <CameraAlertZaloPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          scope={scope}
          repository={repository}
          currentAccountId={accountId}
          currentConversationId={conversationId}
          onPick={(group) => {
            setPicked(group);
            form.setValue("zaloAccountId", group.accountId, { shouldDirty: true });
            form.setValue("zaloConversationId", group.id, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
          }}
        />

        <AlertDialog open={confirmLive !== null} onOpenChange={(next) => { if (!next) setConfirmLive(null); }}>
          <AlertDialogContent className="network-center network-center-dialog nc-dialog nc-dialog-fit">
            <AlertDialogHeader>
              <AlertDialogTitle>Bật gửi thật?</AlertDialogTitle>
              <AlertDialogDescription>
                Trong vài phút sau khi lưu, hệ thống gửi MỘT tin “Hiện trạng camera lúc bật cảnh báo” vào
                {groupName ? <> nhóm Zalo “{groupName}”</> : " nhóm Zalo đã chọn"}, liệt kê mọi sự cố camera đang có. Từ đó cảnh báo thật được gửi vào nhóm này theo các loại đã bật, tối đa {form.getValues("dailyZaloCap")} tin mỗi ngày.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {enabled && mode === "LIVE" && !conversationId ? <p className="nc-form-error">Chưa chọn nhóm Zalo.</p> : null}
            {liveBlockedBy ? <p className="nc-form-error" role="alert">{liveBlockedBy} Tin hiện trạng chỉ gửi một lần nên chưa bật gửi thật được.</p> : null}
            <AlertDialogFooter>
              <AlertDialogCancel>Huỷ</AlertDialogCancel>
              <AlertDialogAction disabled={liveBlockedBy !== null} onClick={() => {
                const patch = confirmLive;
                setConfirmLive(null);
                if (patch) void save(patch);
              }}>Bật gửi thật và lưu</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </form>
    </Form>
  );
}

function ClockField({ control, name, label, disabled }: {
  control: Control<CameraAlertFormValues>;
  name: "nightStart" | "nightEnd" | "digestAt";
  label: string;
  disabled: boolean;
}) {
  return (
    <FormField control={control} name={name} render={({ field }) => (
      <FormItem className="nc-field">
        <FormLabel>{label}</FormLabel>
        <FormControl><Input type="time" step={60} disabled={disabled} {...field} /></FormControl>
        <FormMessage />
      </FormItem>
    )} />
  );
}

function AlertTypeRow({ code, control, disabled }: { code: CameraAlertTypeCode; control: Control<CameraAlertFormValues>; disabled: boolean }) {
  const info = CAMERA_ALERT_TYPE_INFO[code];
  const rowEnabled = useWatch({ control, name: `types.${code}.enabled` });
  const isCount = code === FLAPPING_CODE;
  return (
    <div className="nc-alert-type" role="group" aria-label={info.label}>
      <div className="nc-alert-type-label">
        <span className={`nc-status nc-status-${info.severity === "CRITICAL" ? "bad" : info.severity === "WARNING" ? "warn" : "info"}`}>{CAMERA_ALERT_SEVERITY_LABELS[info.severity]}</span>
        <strong>{info.label}</strong>
        <p>{info.hint}</p>
      </div>
      <FormField control={control} name={`types.${code}.enabled`} render={({ field }) => (
        <FormItem className="nc-alert-type-switch">
          <FormLabel className="sr-only">Bật báo: {info.label}</FormLabel>
          <FormControl><Switch className="nc-alert-switch" checked={field.value} onCheckedChange={field.onChange} disabled={disabled} /></FormControl>
          <span aria-hidden="true">{field.value ? "Bật" : "Tắt"}</span>
        </FormItem>
      )} />
      <FormField control={control} name={`types.${code}.delivery`} render={({ field }) => (
        <FormItem className="nc-field nc-alert-type-delivery">
          <FormLabel>Cách báo</FormLabel>
          <Select value={field.value} onValueChange={field.onChange} disabled={disabled || !rowEnabled}>
            <FormControl><SelectTrigger aria-label={`Cách báo: ${info.label}`}><SelectValue /></SelectTrigger></FormControl>
            <SelectContent className="network-center nc-select-content">
              {deliveryOptionsFor(code).map((option) => <SelectItem key={option} value={option}>{CAMERA_ALERT_DELIVERY_LABELS[option]}</SelectItem>)}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )} />
      <FormField control={control} name={`types.${code}.threshold`} render={({ field }) => (
        <FormItem className="nc-field nc-alert-type-threshold">
          <FormLabel>{isCount ? "Báo khi rớt từ" : "Báo sau"}</FormLabel>
          <div className="nc-threshold">
            <FormControl>
              <Input type="number" inputMode="decimal" min={isCount ? 2 : 0} max={isCount ? 200 : 1440} step={1}
                aria-label={`${isCount ? "Số lần rớt" : "Ngưỡng (phút)"}: ${info.label}`} disabled={disabled || !rowEnabled}
                name={field.name} ref={field.ref} onBlur={field.onBlur}
                value={Number.isFinite(field.value) ? field.value : ""}
                onChange={(event) => field.onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} />
            </FormControl>
            <span>{isCount ? "lần / 24 giờ" : "phút"}</span>
          </div>
          <FormMessage />
        </FormItem>
      )} />
    </div>
  );
}
