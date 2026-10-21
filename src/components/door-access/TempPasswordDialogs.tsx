import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, Loader2, MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useCreateTempPassword } from "@/hooks/door-access/useDoorAccessMutations";
import { PURPOSES, type CreatedTempPassword, type DoorDevice } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { PURPOSE_LABEL } from "@/lib/door-access/format";
import {
  TEMP_PASSWORD_MAX_DAYS,
  TEMP_PASSWORD_NAME_MAX,
  VALIDITY_PRESETS,
  VALIDITY_PRESET_LABEL,
  computeValidity,
  defaultTempPasswordValues,
  tempPasswordFormSchema,
  tempPasswordMessage,
  validityText,
  type TempPasswordFormValues,
} from "@/lib/door-access/tempPassword";
import { focusFirstError } from "@/lib/formErrors";
import { cn } from "@/lib/utils";

import { Notice } from "./parts";

function ChoiceChips<T extends string>({
  label,
  options,
  value,
  onChange,
  labels,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  labels: Record<T, string>;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
          className={cn(
            "h-9 rounded-full border px-3.5 text-sm transition-colors disabled:opacity-50",
            value === option ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
          )}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}

const UNKNOWN_CREATE =
  "Chưa rõ đã tạo mật khẩu chưa — mạng hoặc SmartLife không phản hồi kịp. Xem danh sách mật khẩu tạm và Nhật ký thao tác trước khi tạo lại.";

export function CreateTempPasswordDialog({
  open,
  onOpenChange,
  caller,
  device,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caller: DoorAccessCaller;
  device: DoorDevice;
  onCreated: (result: CreatedTempPassword) => void;
}) {
  const create = useCreateTempPassword(caller);
  const schema = useMemo(() => tempPasswordFormSchema(() => Date.now()), []);
  const form = useForm<TempPasswordFormValues>({
    resolver: zodResolver(schema),
    defaultValues: defaultTempPasswordValues(Date.now()),
  });
  const { reset } = form;
  const resetMutation = create.reset;

  useEffect(() => {
    if (!open) return;
    reset(defaultTempPasswordValues(Date.now()));
    resetMutation();
  }, [open, reset, resetMutation]);

  const values = form.watch();
  const preview = computeValidity({ preset: values.preset, from: values.from, to: values.to }, Date.now());
  const busy = form.formState.isSubmitting || create.isPending;

  const submit = form.handleSubmit(
    async (data) => {
      form.clearErrors("root.server");
      const validity = computeValidity({ preset: data.preset, from: data.from, to: data.to }, Date.now());
      if (!validity.ok) {
        form.setError(validity.field, { message: validity.message });
        return;
      }
      try {
        const result = await create.mutateAsync({
          deviceId: device.id,
          name: data.name.trim(),
          purpose: data.purpose,
          effectiveSec: validity.effectiveSec,
          invalidSec: validity.invalidSec,
        });
        // Mã chỉ còn ở state của hộp kết quả — bỏ khỏi observer của mutation ngay.
        resetMutation();
        onCreated(result);
        onOpenChange(false);
      } catch (error) {
        form.setError("root.server", {
          message: isDoorAccessError(error) && error.outcomeUnknown ? UNKNOWN_CREATE : doorErrorMessage(error, "Chưa tạo được mật khẩu tạm."),
        });
      }
    },
    (errors) => {
      void focusFirstError(errors);
    },
  );

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] max-w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tạo mật khẩu tạm</DialogTitle>
          <DialogDescription>
            Máy {device.display_name}. CRM tự sinh số; dùng nhiều lần trong thời hạn.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tên</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Xem phòng P302" autoComplete="off" disabled={busy} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">Tối đa {TEMP_PASSWORD_NAME_MAX} ký tự — hiện trong app SmartLife.</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="purpose"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Mục đích</FormLabel>
                  <ChoiceChips label="Mục đích" options={PURPOSES} value={field.value} onChange={field.onChange} labels={PURPOSE_LABEL} disabled={busy} />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="preset"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hiệu lực</FormLabel>
                  <ChoiceChips
                    label="Hiệu lực"
                    options={VALIDITY_PRESETS}
                    value={field.value}
                    onChange={field.onChange}
                    labels={VALIDITY_PRESET_LABEL}
                    disabled={busy}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />
            {values.preset === "custom" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="from"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Bắt đầu</FormLabel>
                      <FormControl>
                        <Input {...field} type="datetime-local" disabled={busy} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="to"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Kết thúc</FormLabel>
                      <FormControl>
                        <Input {...field} type="datetime-local" disabled={busy} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-xs text-muted-foreground sm:col-span-2">Giờ Việt Nam, tối đa {TEMP_PASSWORD_MAX_DAYS} ngày.</p>
              </div>
            )}
            {preview.ok && (
              <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                Hiệu lực {validityText(preview.effectiveSec, preview.invalidSec)}
              </p>
            )}
            {form.formState.errors.root?.server?.message && <Notice tone="error">{form.formState.errors.root.server.message}</Notice>}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Huỷ
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                Tạo mật khẩu
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hộp hiện mã vừa tạo. Mã chỉ sống trong props của hộp này (state của tab cha xoá ngay khi đóng):
 * không ghi localStorage, không vào bộ đệm query, không log.
 */
export function TempPasswordResultDialog({
  result,
  deviceName,
  onClose,
}: {
  result: CreatedTempPassword | null;
  deviceName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<"code" | "message" | "failed" | null>(null);
  useEffect(() => setCopied(null), [result]);
  if (!result) return null;
  const validity = validityText(result.effectiveSec, result.invalidSec);
  const copy = async (what: "code" | "message") => {
    const ok = await copyText(
      what === "code" ? result.password : tempPasswordMessage(deviceName, result.password, result.effectiveSec, result.invalidSec),
    );
    setCopied(ok ? what : "failed");
  };
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-[calc(100vw-1.5rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mật khẩu tạm đã tạo</DialogTitle>
          <DialogDescription>
            Máy {deviceName} · hiệu lực {validity}.
          </DialogDescription>
        </DialogHeader>
        <p
          aria-label="Mã mật khẩu tạm"
          className="select-all rounded-xl border bg-muted/40 py-4 text-center font-mono text-4xl font-bold tracking-[0.3em] tabular-nums"
        >
          {result.password}
        </p>
        <Notice tone="warning">
          <span className="font-medium">Mã chỉ hiện một lần.</span> CRM không lưu mã — sao chép hoặc ghi lại trước khi đóng.
        </Notice>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="outline" onClick={() => void copy("code")}>
            <Copy className="mr-2 h-4 w-4" aria-hidden="true" />
            Sao chép mã
          </Button>
          <Button type="button" variant="outline" onClick={() => void copy("message")}>
            <MessageSquareText className="mr-2 h-4 w-4" aria-hidden="true" />
            Sao chép tin nhắn
          </Button>
        </div>
        {copied === "code" && <Notice tone="success">Đã sao chép mã.</Notice>}
        {copied === "message" && <Notice tone="success">Đã sao chép tin nhắn.</Notice>}
        {copied === "failed" && (
          <Notice tone="error">Trình duyệt không cho sao chép — hãy ghi lại mã.</Notice>
        )}
        <p className="text-xs text-muted-foreground">Máy có thể cần vài phút để nhận mật khẩu từ SmartLife.</p>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Đã ghi lại mã
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
