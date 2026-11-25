import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, ChevronRight, Clock, Copy, History, Info, Loader2, Send, Trash2, X } from "lucide-react";

import { useCreateTempPassword, useDeleteTempPassword } from "@/hooks/door-access/useDoorAccessMutations";
import { useDoorTempPasswordLogs, useDoorTempPasswords } from "@/hooks/door-access/useDoorAccessQueries";
import { PURPOSES, type CreatedTempPassword, type DoorDevice, type TempPasswordPurpose } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { PURPOSE_LABEL, formatTimeDay, vnDate } from "@/lib/door-access/format";
import { doorLabel, formatDayMonth, tempPasswordCards, tempPasswordShareText, validityWindowText, type TempPasswordCard } from "@/lib/door-access/mobile";
import {
  TEMP_PASSWORD_MAX_DAYS,
  TEMP_PASSWORD_NAME_MAX,
  VALIDITY_PRESETS,
  VALIDITY_PRESET_LABEL,
  computeValidity,
  defaultTempPasswordValues,
  indexTempPasswordLogs,
  tempPasswordFormSchema,
  type TempPasswordFormValues,
} from "@/lib/door-access/tempPassword";
import { focusFirstError } from "@/lib/formErrors";

import { MobileFullScreen, MobileSheet } from "./MobileSheet";
import { MobileError, MobileLoading, MobileNotice, MobileResultNotice, type MobileResult } from "./mobileParts";

const READ_ONLY_TEMP = "Đang ở chế độ chỉ đọc — chưa tạo hoặc xoá mã được.";

// ---------------------------------------------------------------------------------------------
// Danh sách

function TempCard({
  card,
  asking,
  writable,
  busy,
  onAsk,
  onCancel,
  onRemove,
}: {
  card: TempPasswordCard;
  asking: boolean;
  writable: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  return (
    <article className="card flex flex-col gap-[7px] py-[11px] pl-3.5 pr-3" aria-label={`Mã ${card.name}`}>
      <div className="flex items-center gap-2">
        <h3 className="m-0 min-w-0 flex-1 truncate text-[15px] font-bold tracking-[-.2px]">{card.name}</h3>
        {card.purpose && <span className="pill pill-plain">{card.purpose}</span>}
        <button
          type="button"
          className="xbtn sm"
          aria-label={`Xoá mã ${card.name}`}
          aria-disabled={writable && !busy ? undefined : "true"}
          title={writable ? undefined : READ_ONLY_TEMP}
          onClick={() => writable && !busy && onAsk()}
        >
          <Trash2 className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </div>
      {card.window && (
        <div className="flex items-baseline justify-between gap-2 text-[13px]">
          <span className="mono font-bold">{card.window}</span>
          <span className="font-semibold" style={{ color: card.soon ? "var(--amber)" : "var(--ink-mute)" }}>
            {card.left}
          </span>
        </div>
      )}
      {card.window && (
        <div className={card.soon ? "bar warn" : "bar"} aria-hidden="true">
          <i style={{ width: `${card.remainingPct}%` }} />
        </div>
      )}
      {card.meta && <div className="row-s wrap" style={{ marginTop: 0 }}>{card.meta}</div>}
      {asking && (
        <div className="note note-danger flex-col gap-2.5" style={{ padding: "11px 12px" }} role="alertdialog" aria-label={`Xoá mã ${card.name}?`}>
          <span>Xoá mã này? Người đang giữ mã sẽ không mở được cửa nữa khi máy nhận lệnh.</span>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} autoFocus>
              Giữ lại
            </button>
            <button type="button" className="btn btn-danger-solid btn-sm" disabled={busy} onClick={onRemove}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Xoá mã
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

export function MobileTempPasswords({
  caller,
  device,
  writable,
  createOpen,
  onCreateOpenChange,
  onOpenHistory,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  writable: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onOpenHistory: (() => void) | null;
}) {
  const list = useDoorTempPasswords(caller, device.id);
  const logs = useDoorTempPasswordLogs(caller, device.id);
  const remove = useDeleteTempPassword(caller);
  const createdBy = useMemo(() => indexTempPasswordLogs(logs.data?.logs ?? []), [logs.data]);
  const { active, upcoming } = useMemo(() => tempPasswordCards(list.data?.passwords ?? [], createdBy, Date.now()), [list.data, createdBy]);

  const [asking, setAsking] = useState<number | null>(null);
  const [notice, setNotice] = useState<MobileResult | null>(null);
  // Mã vừa tạo CHỈ nằm ở state này và bị xoá khi đóng màn kết quả.
  const [created, setCreated] = useState<{ result: CreatedTempPassword; name: string; purpose: TempPasswordPurpose } | null>(null);

  const confirmDelete = (card: TempPasswordCard) => {
    if (remove.isPending) return;
    setNotice(null);
    remove.mutate(
      { deviceId: device.id, passwordId: card.id },
      {
        onSuccess: (data) => {
          setAsking(null);
          setNotice({
            logPending: data.logPending === true,
            ...(data.deleted
              ? { tone: "ok" as const, text: `Đã gửi lệnh xoá mã «${card.name}».` }
              : { tone: "warn" as const, text: "SmartLife chưa xác nhận đã xoá — làm mới danh sách để kiểm tra." }),
          });
        },
        onError: (error) => {
          setAsking(null);
          setNotice({
            logPending: isDoorAccessError(error) && error.logPending,
            ...(isDoorAccessError(error) && error.outcomeUnknown
              ? { tone: "warn" as const, text: "Chưa rõ đã xoá chưa — làm mới danh sách và xem Nhật ký thao tác trước khi thử lại." }
              : { tone: "danger" as const, text: doorErrorMessage(error, "Chưa xoá được mã tạm.") }),
          });
        },
      },
    );
  };

  const sections = [
    { key: "active", title: "Đang hiệu lực", items: active },
    { key: "upcoming", title: "Sắp hiệu lực", items: upcoming },
  ].filter((section) => section.items.length > 0);

  return (
    <>
      <MobileNotice tone="info">CRM không lưu mã. Mã chỉ hiện một lần lúc tạo; cần gửi lại thì tạo mã mới.</MobileNotice>
      {!writable && <MobileNotice tone="warn">{READ_ONLY_TEMP}</MobileNotice>}
      {notice && <MobileResultNotice result={notice} />}
      {logs.isError && (
        <MobileNotice tone="warn">
          Chưa tải được nhật ký tạo mã — chưa hiện được người tạo.{" "}
          <button type="button" className="font-semibold underline" onClick={() => void logs.refetch()}>
            Tải lại
          </button>
        </MobileNotice>
      )}
      {list.data === undefined && list.isPending && <MobileLoading text="Đang đọc mã tạm trên máy cửa…" />}
      {list.data === undefined && list.isError && <MobileError error={list.error} title="Chưa tải được mã tạm" onRetry={() => void list.refetch()} />}
      {list.data !== undefined && sections.length === 0 && <div className="card empty">Cửa này chưa có mã tạm nào còn hiệu lực.</div>}
      {sections.map((section) => (
        <section key={section.key} className="sec" aria-label={section.title}>
          <div className="sec-h">
            <h2>{section.title}</h2>
            <span className="count">{section.items.length}</span>
          </div>
          {section.items.map((card) => (
            <TempCard
              key={card.id}
              card={card}
              asking={asking === card.id}
              writable={writable}
              busy={remove.isPending}
              onAsk={() => {
                setNotice(null);
                setAsking(card.id);
              }}
              onCancel={() => setAsking(null)}
              onRemove={() => confirmDelete(card)}
            />
          ))}
        </section>
      ))}
      {list.data?.hasMore && <p className="hint">SmartLife còn mã chưa liệt kê hết.</p>}
      {list.data !== undefined && list.isRefetchError && <MobileNotice tone="warn">Chưa làm mới được — đang hiện danh sách lần trước.</MobileNotice>}
      {list.data !== undefined && (
        <button type="button" className="btn btn-ghost btn-sm self-center" disabled={list.isFetching} onClick={() => void list.refetch()}>
          {list.isFetching ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Clock aria-hidden="true" />}
          Làm mới danh sách
        </button>
      )}
      {onOpenHistory && (
        <button type="button" className="card flex min-h-[52px] items-center gap-2.5 px-3.5 text-left text-[13px] text-[var(--ink-2)]" onClick={onOpenHistory}>
          <History className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
          <span className="flex-1">Mã hết hạn: xem lượt dùng ở Lịch sử ra vào</span>
          <ChevronRight className="row-chev h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      )}

      <CreateTempSheet
        open={createOpen && writable}
        caller={caller}
        device={device}
        onClose={() => onCreateOpenChange(false)}
        onCreated={(next) => {
          setNotice(null);
          onCreateOpenChange(false);
          setCreated(next);
        }}
      />
      <CreatedTempScreen created={created} device={device} onClose={() => setCreated(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tạo mã

const UNKNOWN_CREATE = "Chưa rõ đã tạo mã chưa — mạng hoặc SmartLife không phản hồi kịp. Xem danh sách mã và Nhật ký thao tác trước khi tạo lại.";

function CreateTempSheet({
  open,
  caller,
  device,
  onClose,
  onCreated,
}: {
  open: boolean;
  caller: DoorAccessCaller;
  device: DoorDevice;
  onClose: () => void;
  onCreated: (created: { result: CreatedTempPassword; name: string; purpose: TempPasswordPurpose }) => void;
}) {
  const create = useCreateTempPassword(caller);
  const schema = useMemo(() => tempPasswordFormSchema(() => Date.now()), []);
  const form = useForm<TempPasswordFormValues>({ resolver: zodResolver(schema), defaultValues: defaultTempPasswordValues(Date.now()) });
  const { reset } = form;
  const resetMutation = create.reset;
  const [server, setServer] = useState<MobileResult | null>(null);

  useEffect(() => {
    if (!open) return;
    reset(defaultTempPasswordValues(Date.now()));
    resetMutation();
    setServer(null);
  }, [open, reset, resetMutation]);

  const values = form.watch();
  const now = Date.now();
  const preview = computeValidity({ preset: values.preset, from: values.from, to: values.to }, now);
  const busy = form.formState.isSubmitting || create.isPending;
  const nameLength = [...values.name.trim()].length;
  const errors = form.formState.errors;
  const latest = formatTimeDay(now + TEMP_PASSWORD_MAX_DAYS * 86_400_000);
  const previewNote = !preview.ok
    ? null
    : values.preset === "custom"
      ? `tối đa đến ${latest}`
      : vnDate(preview.effectiveSec * 1000) === vnDate(preview.invalidSec * 1000)
        ? `hôm nay, ${formatDayMonth(preview.effectiveSec * 1000)}`
        : null;

  const submit = form.handleSubmit(
    async (data) => {
      setServer(null);
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
        // Mã chỉ còn ở state của màn kết quả — bỏ khỏi observer của mutation ngay.
        resetMutation();
        onCreated({ result, name: data.name.trim(), purpose: data.purpose });
      } catch (error) {
        setServer({
          tone: isDoorAccessError(error) && error.outcomeUnknown ? "warn" : "danger",
          text: isDoorAccessError(error) && error.outcomeUnknown ? UNKNOWN_CREATE : doorErrorMessage(error, "Chưa tạo được mã tạm."),
          logPending: isDoorAccessError(error) && error.logPending,
        });
      }
    },
    (formErrors) => {
      void focusFirstError(formErrors);
    },
  );

  return (
    <MobileSheet open={open} onClose={onClose} busy={busy} title="Tạo mã tạm" description={`${doorLabel(device)}. CRM tự sinh mã ${device.password_length} số.`}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <div className="field">
          <label className="label" htmlFor="dam-temp-name">
            Tên gợi nhớ{" "}
            <span className="count">
              {nameLength}/{TEMP_PASSWORD_NAME_MAX}
            </span>
          </label>
          <input
            id="dam-temp-name"
            className="input"
            type="text"
            autoComplete="off"
            placeholder="Ví dụ: Khách xem phòng P302"
            aria-describedby="dam-temp-name-hint"
            aria-invalid={errors.name ? "true" : undefined}
            disabled={busy}
            {...form.register("name")}
          />
          {errors.name?.message ? (
            <p className="err" role="alert">
              {errors.name.message}
            </p>
          ) : (
            <span className="hint" id="dam-temp-name-hint">
              Hiện trong danh sách mã, lịch sử ra vào và app SmartLife.
            </span>
          )}
        </div>
        <fieldset className="field">
          <legend className="label" style={{ marginBottom: 7 }}>
            Dùng cho
          </legend>
          <div className="seg">
            {PURPOSES.map((purpose) => (
              <button
                key={purpose}
                type="button"
                aria-pressed={values.purpose === purpose}
                disabled={busy}
                onClick={() => form.setValue("purpose", purpose, { shouldValidate: false })}
              >
                {PURPOSE_LABEL[purpose]}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend className="label" style={{ marginBottom: 7 }}>
            Hiệu lực
          </legend>
          <div className="seg">
            {VALIDITY_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={values.preset === preset}
                disabled={busy}
                onClick={() => {
                  form.setValue("preset", preset, { shouldValidate: false });
                  form.clearErrors(["preset", "from", "to"]);
                }}
              >
                {VALIDITY_PRESET_LABEL[preset]}
              </button>
            ))}
          </div>
          {values.preset === "custom" && (
            <div className="mt-1 grid grid-cols-2 gap-2">
              <label className="field" style={{ gap: 5 }}>
                <span className="hint" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
                  Bắt đầu
                </span>
                <input className="input sm" type="datetime-local" disabled={busy} aria-invalid={errors.from ? "true" : undefined} {...form.register("from")} />
              </label>
              <label className="field" style={{ gap: 5 }}>
                <span className="hint" style={{ fontWeight: 600, color: "var(--ink-2)" }}>
                  Kết thúc
                </span>
                <input className="input sm" type="datetime-local" disabled={busy} aria-invalid={errors.to ? "true" : undefined} {...form.register("to")} />
              </label>
            </div>
          )}
          {(errors.preset?.message || errors.from?.message || errors.to?.message) && (
            <p className="err" role="alert">
              {errors.preset?.message ?? errors.from?.message ?? errors.to?.message}
            </p>
          )}
          {preview.ok && (
            <div className="mt-0.5 flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2.5 text-[13px]">
              <Clock className="h-4 w-4 shrink-0 text-[var(--ink-2)]" aria-hidden="true" />
              <span>
                <strong className="mono font-bold">{validityWindowText(preview.effectiveSec, preview.invalidSec, now)}</strong>{" "}
                {previewNote && <span className="mute">{previewNote}</span>}
              </span>
            </div>
          )}
          {values.preset === "custom" && <span className="hint">Giờ Việt Nam, hết hạn chậm nhất {TEMP_PASSWORD_MAX_DAYS} ngày kể từ bây giờ.</span>}
        </fieldset>
        {server && <MobileResultNotice result={server} />}
        <div className="flex flex-col gap-1.5">
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || nameLength === 0}>
            {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
            {busy ? "Đang tạo mã…" : "Tạo mã"}
          </button>
          {nameLength === 0 && !busy && <span className="hint text-center">Nhập tên gợi nhớ để biết mã này đưa cho ai.</span>}
        </div>
        <p className="hint -mt-1.5 text-center">Mã dùng được nhiều lần trong thời gian hiệu lực.</p>
      </form>
    </MobileSheet>
  );
}

// ---------------------------------------------------------------------------------------------
// Mã vừa tạo — chỉ hiện một lần

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type ShareState = "shared" | "copied" | "failed" | null;

/**
 * "Gửi qua Zalo" = hộp chia sẻ của điện thoại (Web Share API) với tin soạn sẵn; người dùng tự chọn Zalo,
 * người nhận và bấm gửi. Máy/trình duyệt không có hộp chia sẻ ⇒ sao chép tin để dán vào Zalo.
 */
async function shareMessage(text: string): Promise<ShareState | "cancelled"> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return "shared";
    } catch (error) {
      // Người dùng tự đóng hộp chia sẻ: không coi là lỗi, không tự sao chép.
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
    }
  }
  return (await copyText(text)) ? "copied" : "failed";
}

function CreatedTempScreen({
  created,
  device,
  onClose,
}: {
  created: { result: CreatedTempPassword; name: string; purpose: TempPasswordPurpose } | null;
  device: DoorDevice;
  onClose: () => void;
}) {
  const [state, setState] = useState<ShareState>(null);
  useEffect(() => setState(null), [created]);
  if (!created) return null;
  const { result, name, purpose } = created;
  const now = Date.now();
  const message = tempPasswordShareText({
    doorName: device.display_name,
    buildingName: device.building_name,
    code: result.password,
    effectiveSec: result.effectiveSec,
    invalidSec: result.invalidSec,
    nowMs: now,
  });
  // Tô đậm mã trong tin (mã đứng ngay sau "Mã mở …: ").
  const codeAt = message.indexOf(`: ${result.password}`) + 2;
  const before = message.slice(0, codeAt);
  const after = message.slice(codeAt + result.password.length);
  const status =
    state === "shared"
      ? "Đã mở hộp chia sẻ."
      : state === "copied"
        ? "Đã sao chép tin. Dán vào Zalo hoặc tin nhắn để gửi."
        : state === "failed"
          ? "Trình duyệt không cho sao chép — hãy ghi lại mã."
          : "";

  return (
    <MobileFullScreen open onClose={onClose} label={`Mã tạm cho ${name}`}>
      <div className="dam-app">
        <header className="mtop">
          <div className="mtitle pl-1">
            <h1>Mã tạm đã tạo</h1>
            <p>{doorLabel(device)}</p>
          </div>
          <div className="mtop-act">
            <button type="button" className="xbtn" aria-label="Đóng, về danh sách mã" onClick={onClose}>
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="mbody" style={{ gap: 14, paddingTop: 18 }}>
          <div className="flex flex-col items-center gap-2.5 text-center">
            <span className="grid h-[52px] w-[52px] place-items-center rounded-full bg-[var(--brand-50)] text-[var(--brand)]">
              <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
            </span>
            <h2 className="m-0 text-lg font-bold tracking-[-.3px]">Mã cho «{name}»</h2>
          </div>
          <div className="code" role="img" aria-label={`Mã ${result.password.split("").join(" ")}`}>
            {result.password.split("").map((digit, index) => (
              <span key={index}>{digit}</span>
            ))}
          </div>
          <div className="kv">
            <div className="kv-row">
              <span>Hiệu lực</span>
              <span className="mono">{validityWindowText(result.effectiveSec, result.invalidSec, now)}</span>
            </div>
            <div className="kv-row">
              <span>Dùng cho</span>
              <span>{PURPOSE_LABEL[purpose]} · dùng nhiều lần</span>
            </div>
            <div className="kv-row">
              <span>Trên máy cửa</span>
              <span>Máy nhận sau ít phút</span>
            </div>
          </div>
          <MobileNotice tone="warn">Mã chỉ hiện lần này. Rời màn này là không xem lại được, vì CRM không lưu mã.</MobileNotice>
          {result.logPending && <MobileNotice tone="info">Nhật ký thao tác chưa chốt được — kiểm lại ở Quản lý › Nhật ký.</MobileNotice>}
          <figure className="m-0 flex flex-col gap-1.5">
            <figcaption className="label">Tin soạn sẵn để gửi</figcaption>
            <div className="card flat bg-[var(--surface-2)] px-3.5 py-3 text-[13px] leading-[1.55] text-[var(--ink-2)]">
              {before}
              <strong className="mono text-[var(--ink)]">{result.password}</strong>
              {after}
            </div>
          </figure>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void shareMessage(message).then((next) => {
                  if (next !== "cancelled") setState(next);
                })
              }
            >
              <Send aria-hidden="true" />
              Gửi qua Zalo
            </button>
            <button type="button" className={state === "copied" ? "btn btn-soft" : "btn btn-ghost"} onClick={() => void copyText(message).then((ok) => setState(ok ? "copied" : "failed"))}>
              {state === "copied" ? <CheckCircle2 aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {state === "copied" ? "Đã sao chép" : "Sao chép tin"}
            </button>
          </div>
          <p role="status" className="hint -mt-1.5 min-h-[17px] text-center">
            {status}
          </p>
          <div className="flex items-start gap-2 text-xs text-[var(--ink-mute)]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Gửi qua Zalo mở hộp chia sẻ của điện thoại; bạn tự chọn Zalo, người nhận và bấm gửi.</span>
          </div>
          <button type="button" className="btn btn-ghost btn-block mt-auto" onClick={onClose}>
            Xong
          </button>
        </main>
      </div>
    </MobileFullScreen>
  );
}
