import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, ChevronDown, Info, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";

import { useDeleteKey, useLinkKey, useUnlinkKey } from "@/hooks/door-access/useDoorAccessMutations";
import { useDoorKeyLinks, useDoorKeys, useDoorTenants } from "@/hooks/door-access/useDoorAccessQueries";
import type { DoorDevice, DoorKeyLink, DoorTenancy } from "@/lib/door-access/dto";
import type { DoorAccessCaller } from "@/lib/door-access/edge";
import { doorErrorMessage, isDoorAccessError } from "@/lib/door-access/errors";
import { KEY_LABEL_MAX, linkKeyFormSchema, tenantOptions, type LinkKeyFormValues } from "@/lib/door-access/forms";
import { TENANCY_LABEL, formatDateVn, unlockTypeLabel } from "@/lib/door-access/format";
import { customerKeysText, doorLabel, foldVi, reconcileRowTitle, reconcileSections } from "@/lib/door-access/mobile";
import { reconcileKeys, type ReconcileRow } from "@/lib/door-access/reconcile";
import { linkDisplayName } from "@/lib/door-access/records";
import { deleteBlockedReason, rowOwner } from "@/lib/door-access/view";
import { focusFirstError } from "@/lib/formErrors";

import { MobileSheet } from "./MobileSheet";
import { MobileError, MobileLoading, MobileNotice, MobileResultNotice, type MobileResult } from "./mobileParts";

const TENANCY_PILL: Record<DoorTenancy, string> = {
  CURRENT: "pill pill-ok",
  MOVED_OUT: "pill pill-alarm",
  NO_CONTRACT: "pill pill-temp",
  STAFF: "pill pill-plain",
};

function linkSub(link: DoorKeyLink): string {
  if (link.tenancy === "STAFF") return "Nhãn nhân viên";
  const parts = [link.room_name, link.contract_end_date ? `HĐ đến ${formatDateVn(link.contract_end_date)}` : null].filter(Boolean);
  return parts.join(" · ") || TENANCY_LABEL[link.tenancy];
}

export function MobileReconcile({
  caller,
  device,
  writable,
  onCountsChange,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  writable: boolean;
  onCountsChange?: (needsDelete: number) => void;
}) {
  const keys = useDoorKeys(caller, device.id);
  const links = useDoorKeyLinks(caller, device.id);
  const result = useMemo(() => (keys.data && links.data ? reconcileKeys(keys.data, links.data) : null), [keys.data, links.data]);
  const sections = useMemo(() => (result ? reconcileSections(result) : null), [result]);
  const canManage = device.can.manage_devices;
  const [linkRow, setLinkRow] = useState<ReconcileRow | null>(null);
  const [unlinkRow, setUnlinkRow] = useState<ReconcileRow | null>(null);
  const [deleteRow, setDeleteRow] = useState<ReconcileRow | null>(null);
  const [actionRow, setActionRow] = useState<ReconcileRow | null>(null);
  const [openOk, setOpenOk] = useState(false);
  const [notice, setNotice] = useState<MobileResult | null>(null);
  const fetching = keys.isFetching || links.isFetching;

  const needsDelete = sections?.needsDelete.length ?? null;
  useEffect(() => {
    if (needsDelete !== null) onCountsChange?.(needsDelete);
  }, [needsDelete, onCountsChange]);

  const refresh = () => {
    void keys.refetch();
    void links.refetch();
  };

  return (
    <>
      {notice && <MobileResultNotice result={notice} />}
      {keys.isError && keys.data === undefined && <MobileError error={keys.error} title="Chưa đọc được danh sách trên máy" onRetry={() => void keys.refetch()} />}
      {links.isError && links.data === undefined && <MobileError error={links.error} title="Chưa tải được danh sách đã gắn" onRetry={() => void links.refetch()} />}
      {(keys.data === undefined || links.data === undefined) && !keys.isError && !links.isError && <MobileLoading text="Đang đọc vân tay, thẻ trên máy cửa…" />}

      {result && sections && (
        <>
          {result.partial && (
            <MobileNotice tone="warn">Máy trả danh sách chưa đầy đủ — mục «Không còn trên máy» có thể chưa đúng. Làm mới sau ít phút.</MobileNotice>
          )}
          {(keys.isRefetchError || links.isRefetchError) && <MobileNotice tone="warn">Chưa làm mới được — đang hiện dữ liệu lần trước.</MobileNotice>}
          <div className="card stats">
            <div>
              <b>{sections.onDevice}</b>
              <span>Số trên máy</span>
            </div>
            <div>
              <b>{sections.linked}</b>
              <span>Đã gắn người</span>
            </div>
            <div>
              <b>{sections.unlinked}</b>
              <span>Chưa gắn</span>
            </div>
          </div>

          {sections.needsDelete.length > 0 && (
            <section className="sec" aria-labelledby="dam-needs-delete">
              <div className="sec-h">
                <h2 id="dam-needs-delete" style={{ color: "var(--red-ink)" }}>
                  Cần xoá
                </h2>
                <span className="count" style={{ color: "var(--red)" }}>
                  {sections.needsDelete.length}
                </span>
              </div>
              <p className="hint mx-0.5 text-[13px]">Khách đã trả phòng nhưng vân tay, thẻ vẫn mở được cửa. CRM không tự xoá; bạn xoá từng số.</p>
              <ul className="card rows" style={{ borderColor: "var(--red-line)" }}>
                {sections.needsDelete.map((row) => (
                  <li key={row.key} className="row">
                    <span className="row-main">
                      <span className="row-t">{reconcileRowTitle(row)}</span>
                      <span className="row-s">
                        {[row.link?.room_name, row.link?.contract_end_date ? `HĐ hết ${formatDateVn(row.link.contract_end_date)}` : null].filter(Boolean).join(" · ") ||
                          TENANCY_LABEL.MOVED_OUT}
                      </span>
                    </span>
                    {canManage && (
                      <button type="button" className="btn btn-danger btn-sm" aria-label={`Xoá ${reconcileRowTitle(row)} trên máy`} onClick={() => setDeleteRow(row)}>
                        Xoá
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sections.unlinkedRows.length > 0 && (
            <section className="sec" aria-labelledby="dam-unlinked">
              <div className="sec-h">
                <h2 id="dam-unlinked">Chưa gắn người</h2>
                <span className="count">{sections.unlinkedRows.length}</span>
              </div>
              <p className="hint mx-0.5 text-[13px]">Số đã có trên máy nhưng CRM chưa biết của ai. Gắn để lịch sử hiện tên khách.</p>
              <ul className="card rows">
                {sections.unlinkedRows.map((row) => (
                  <li key={row.key} className="row">
                    <span className="row-main">
                      <span className="row-t">{unlockTypeLabel(row.unlockType, row.sn)}</span>
                      <span className="row-s">{row.deviceUserName || row.keyName ? `Tên trên máy: ${[row.deviceUserName, row.keyName].filter(Boolean).join(" · ")}` : "Chưa có tên trên máy"}</span>
                    </span>
                    {canManage && (
                      <button type="button" className="btn btn-soft btn-sm" aria-label={`Gắn ${unlockTypeLabel(row.unlockType, row.sn)}`} onClick={() => setLinkRow(row)}>
                        Gắn
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sections.gone.length > 0 && (
            <section className="sec" aria-labelledby="dam-gone">
              <div className="sec-h">
                <h2 id="dam-gone">{result.partial ? "Chưa thấy trên máy" : "Không còn trên máy"}</h2>
                <span className="count">{sections.gone.length}</span>
              </div>
              <ul className="card rows">
                {sections.gone.map((row) => (
                  <li key={row.key} className="row">
                    <span className="row-main">
                      <span className="row-t">{reconcileRowTitle(row)}</span>
                      <span className="row-s wrap">{[row.link?.room_name, "số đã bị xoá ở máy, CRM vẫn còn gắn"].filter(Boolean).join(" · ")}</span>
                    </span>
                    {canManage && (
                      <button type="button" className="btn btn-ghost btn-sm" aria-label={`Bỏ gắn ${reconcileRowTitle(row)}`} onClick={() => setUnlinkRow(row)}>
                        Bỏ gắn
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sections.linkedOk.length > 0 && (
            <section className="sec">
              <button type="button" className="card flex min-h-[56px] items-center gap-3 px-3.5 text-left" aria-expanded={openOk} onClick={() => setOpenOk((open) => !open)}>
                <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--brand)]" aria-hidden="true" />
                <span className="row-main">
                  <span className="row-t">{sections.linkedOk.length} số đã gắn đúng người</span>
                  {sections.linkedOkSummary && <span className="row-s">{sections.linkedOkSummary}</span>}
                </span>
                <ChevronDown className="row-chev h-5 w-5" style={{ transform: openOk ? "rotate(180deg)" : undefined }} aria-hidden="true" />
              </button>
              {openOk && (
                <ul className="card rows">
                  {sections.linkedOk.map((row) => (
                    <li key={row.key}>
                      <button
                        type="button"
                        className="row"
                        disabled={!canManage}
                        aria-label={canManage ? `${reconcileRowTitle(row)} — đổi, bỏ gắn hoặc xoá` : undefined}
                        onClick={() => canManage && setActionRow(row)}
                      >
                        <span className="row-main">
                          <span className="row-t">{reconcileRowTitle(row)}</span>
                          {row.link && <span className="row-s">{linkSub(row.link)}</span>}
                        </span>
                        {row.link && <span className={TENANCY_PILL[row.link.tenancy]}>{row.link.tenancy === "CURRENT" ? "Đang thuê" : TENANCY_LABEL[row.link.tenancy]}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {sections.onDevice === 0 && sections.gone.length === 0 && <div className="card empty">Máy chưa có vân tay, thẻ hay mật khẩu nào.</div>}
          <MobileNotice tone="info">Thêm vân tay mới vẫn làm tại máy cửa hoặc app SmartLife, rồi quay lại đây để gắn khách.</MobileNotice>
        </>
      )}
      {(keys.data !== undefined || links.data !== undefined) && (
        <button type="button" className="btn btn-ghost btn-sm self-center" disabled={fetching} onClick={refresh}>
          {fetching ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          Đọc lại từ máy
        </button>
      )}

      <LinkSheet caller={caller} device={device} row={linkRow} links={links.data ?? []} onClose={() => setLinkRow(null)} onDone={setNotice} />
      <UnlinkSheet caller={caller} device={device} row={unlinkRow} onClose={() => setUnlinkRow(null)} onDone={setNotice} />
      <DeleteSheet caller={caller} device={device} row={deleteRow} writable={writable} onClose={() => setDeleteRow(null)} onDone={setNotice} />
      <RowActionsSheet
        row={actionRow}
        writable={writable}
        onClose={() => setActionRow(null)}
        onRelink={(row) => {
          setActionRow(null);
          setLinkRow(row);
        }}
        onUnlink={(row) => {
          setActionRow(null);
          setUnlinkRow(row);
        }}
        onDelete={(row) => {
          setActionRow(null);
          setDeleteRow(row);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Thao tác trên một số đã gắn đúng người

function RowActionsSheet({
  row,
  writable,
  onClose,
  onRelink,
  onUnlink,
  onDelete,
}: {
  row: ReconcileRow | null;
  writable: boolean;
  onClose: () => void;
  onRelink: (row: ReconcileRow) => void;
  onUnlink: (row: ReconcileRow) => void;
  onDelete: (row: ReconcileRow) => void;
}) {
  const blocked = row ? deleteBlockedReason(row, writable) : null;
  return (
    <MobileSheet open={row !== null} onClose={onClose} title={row ? reconcileRowTitle(row) : ""} description={row?.link ? linkSub(row.link) : undefined}>
      {row && (
        <div className="flex flex-col gap-2.5">
          <button type="button" className="btn btn-soft btn-block" onClick={() => onRelink(row)}>
            Đổi người gắn
          </button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => onUnlink(row)}>
            Bỏ gắn (giữ số trên máy)
          </button>
          <button type="button" className="btn btn-danger btn-block" disabled={blocked !== null} onClick={() => onDelete(row)}>
            <Trash2 aria-hidden="true" />
            Xoá trên máy
          </button>
          {blocked && <p className="hint text-center">{blocked}.</p>}
        </div>
      )}
    </MobileSheet>
  );
}

// ---------------------------------------------------------------------------------------------
// Gắn khách / nhãn

function LinkSheet({
  caller,
  device,
  row,
  links,
  onClose,
  onDone,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  row: ReconcileRow | null;
  links: readonly DoorKeyLink[];
  onClose: () => void;
  onDone: (result: MobileResult) => void;
}) {
  const tenants = useDoorTenants(caller, device.id, row !== null);
  const link = useLinkKey(caller);
  const options = useMemo(() => tenantOptions(tenants.data ?? []), [tenants.data]);
  const [query, setQuery] = useState("");
  const form = useForm<LinkKeyFormValues>({ resolver: zodResolver(linkKeyFormSchema), defaultValues: { mode: "customer", customerId: "", label: "" } });
  const { reset } = form;
  const resetMutation = link.reset;
  useEffect(() => {
    if (!row) return;
    reset({ mode: row.link?.label ? "label" : "customer", customerId: "", label: row.link?.label ?? "" });
    resetMutation();
    setQuery("");
  }, [row, reset, resetMutation]);

  const mode = form.watch("mode");
  const customerId = form.watch("customerId");
  const busy = link.isPending;
  const key = foldVi(query).trim();
  const shown = key ? options.filter((option) => foldVi(`${option.name} ${option.rooms.join(" ")}`).includes(key)) : options;
  const chosen = options.find((option) => option.customerId === customerId) ?? null;
  const what = row ? unlockTypeLabel(row.unlockType, row.sn) : "";
  const errors = form.formState.errors;

  const submit = form.handleSubmit(
    (values) => {
      if (!row) return;
      form.clearErrors("root.server");
      link.mutate(
        {
          deviceId: device.id,
          unlockType: row.unlockType,
          unlockSn: row.sn,
          tuyaUserId: row.tuyaUserId,
          deviceUserName: row.deviceUserName ?? row.keyName,
          customerId: values.mode === "customer" ? values.customerId : null,
          label: values.mode === "label" ? values.label.trim() : null,
        },
        {
          onSuccess: (saved) => {
            onDone({ tone: "ok", text: `Đã gắn ${what} với ${linkDisplayName(saved)}.` });
            onClose();
          },
          onError: (error) =>
            form.setError("root.server", {
              message:
                isDoorAccessError(error) && error.outcomeUnknown ? "Chưa rõ đã gắn chưa — đọc lại danh sách trước khi thử lại." : doorErrorMessage(error, "Chưa gắn được."),
            }),
        },
      );
    },
    (formErrors) => {
      void focusFirstError(formErrors);
    },
  );

  const description = row
    ? `${row.deviceUserName ? `Tên trên máy: ${row.deviceUserName} · ` : ""}${doorLabel(device)}`
    : undefined;

  return (
    <MobileSheet open={row !== null} onClose={onClose} busy={busy} title={`Gắn ${what}`} description={description}>
      <form className="flex flex-col gap-3.5" onSubmit={(event) => void submit(event)} noValidate>
        <div className="seg" role="group" aria-label="Gắn cho">
          {(["customer", "label"] as const).map((value) => (
            <button key={value} type="button" aria-pressed={mode === value} disabled={busy} onClick={() => form.setValue("mode", value, { shouldValidate: false })}>
              {value === "customer" ? "Khách thuê" : "Nhân viên, khác"}
            </button>
          ))}
        </div>
        {mode === "customer" ? (
          tenants.isError ? (
            <MobileError error={tenants.error} title="Chưa tải được khách ở toà" onRetry={() => void tenants.refetch()} />
          ) : (
            <div className="flex flex-col gap-2.5">
              <label className="search">
                <Search className="h-[18px] w-[18px]" aria-hidden="true" />
                <span className="sr-only">Tìm khách ở toà</span>
                <input type="search" placeholder="Tìm tên hoặc số phòng" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <fieldset className="m-0 border-0 p-0">
                <legend className="hint mb-1.5">Khách từng hoặc đang có hợp đồng ở {device.building_name ?? "toà này"}</legend>
                {tenants.isPending ? (
                  <MobileLoading text="Đang tải khách…" />
                ) : shown.length === 0 ? (
                  <div className="card flat empty">{options.length === 0 ? "Toà chưa có khách nào có hợp đồng." : "Không thấy khách phù hợp."}</div>
                ) : (
                  <div className="card flat rows max-h-[40dvh] overflow-y-auto" role="radiogroup" aria-label="Chọn khách" aria-invalid={errors.customerId ? "true" : undefined}>
                    {shown.map((option) => {
                      const on = option.customerId === customerId;
                      return (
                        <button
                          key={option.customerId}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          className="row radio-row"
                          style={{ minHeight: 56 }}
                          disabled={busy}
                          onClick={() => form.setValue("customerId", option.customerId, { shouldValidate: true })}
                        >
                          <span className="rdot" aria-hidden="true">
                            <i />
                          </span>
                          <span className="row-main">
                            <span className="row-t">{option.name}</span>
                            <span className="row-s">
                              {option.representative ? "Đại diện HĐ" : "Ở cùng"} · {customerKeysText(links, option.customerId)}
                            </span>
                          </span>
                          {option.rooms.length > 0 && <span className="mono text-[13px] font-bold">{option.rooms.join(", ")}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </fieldset>
              {errors.customerId?.message && (
                <p className="err" role="alert">
                  {errors.customerId.message}
                </p>
              )}
              <p className="hint">Gắn vân tay xong, số được điền vào ô «Mã vân tay cửa ra vào» của khách.</p>
            </div>
          )
        ) : (
          <div className="field">
            <label className="label" htmlFor="dam-key-label">
              Ghi nhãn
            </label>
            <input id="dam-key-label" className="input" type="text" autoComplete="off" placeholder="Ví dụ: bảo vệ, thợ quen" disabled={busy} aria-invalid={errors.label ? "true" : undefined} {...form.register("label")} />
            {errors.label?.message ? (
              <p className="err" role="alert">
                {errors.label.message}
              </p>
            ) : (
              <span className="hint">Cho vân tay của nhân viên hoặc người không thuê phòng (tối đa {KEY_LABEL_MAX} ký tự). Lịch sử ra vào hiện nhãn này.</span>
            )}
          </div>
        )}
        {errors.root?.server?.message && <MobileNotice tone="danger">{errors.root.server.message}</MobileNotice>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {mode === "customer" ? (chosen ? `Gắn cho ${chosen.name}${chosen.rooms.length ? ` · ${chosen.rooms[0]}` : ""}` : "Gắn cho khách") : "Gắn nhãn"}
        </button>
      </form>
    </MobileSheet>
  );
}

// ---------------------------------------------------------------------------------------------
// Bỏ gắn

function UnlinkSheet({
  caller,
  device,
  row,
  onClose,
  onDone,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  row: ReconcileRow | null;
  onClose: () => void;
  onDone: (result: MobileResult) => void;
}) {
  const unlink = useUnlinkKey(caller);
  const link = row?.link ?? null;
  const what = row ? unlockTypeLabel(row.unlockType, row.sn) : "";
  const confirm = () => {
    if (!row || !link || unlink.isPending) return;
    unlink.mutate(
      { deviceId: device.id, linkId: link.id },
      {
        onSuccess: () => {
          onDone({ tone: "ok", text: `Đã bỏ gắn ${what} khỏi ${linkDisplayName(link)}.` });
          onClose();
        },
        onError: (error) => {
          onDone({
            tone: isDoorAccessError(error) && error.outcomeUnknown ? "warn" : "danger",
            text: isDoorAccessError(error) && error.outcomeUnknown ? "Chưa rõ đã bỏ gắn chưa — đọc lại danh sách trước khi thử lại." : doorErrorMessage(error, "Chưa bỏ gắn được."),
          });
          onClose();
        },
      },
    );
  };
  return (
    <MobileSheet
      open={row !== null && link !== null}
      onClose={onClose}
      busy={unlink.isPending}
      role="alertdialog"
      title={`Bỏ gắn ${what} khỏi ${link ? linkDisplayName(link) : ""}?`}
      description="Chỉ bỏ liên kết trong CRM; số trên máy giữ nguyên. Ô «Mã vân tay cửa ra vào» của khách cập nhật theo."
    >
      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" className="btn btn-ghost" disabled={unlink.isPending} onClick={onClose}>
          Giữ lại
        </button>
        <button type="button" className="btn btn-primary" disabled={unlink.isPending} onClick={confirm}>
          {unlink.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
          Bỏ gắn
        </button>
      </div>
    </MobileSheet>
  );
}

// ---------------------------------------------------------------------------------------------
// Xoá trên máy — hộp xác nhận nêu đúng người, số, cửa

function DeleteSheet({
  caller,
  device,
  row,
  writable,
  onClose,
  onDone,
}: {
  caller: DoorAccessCaller;
  device: DoorDevice;
  row: ReconcileRow | null;
  writable: boolean;
  onClose: () => void;
  onDone: (result: MobileResult) => void;
}) {
  const remove = useDeleteKey(caller);
  const [problem, setProblem] = useState<MobileResult | null>(null);
  const [done, setDone] = useState<{ text: string; logPending: boolean } | null>(null);
  const resetMutation = remove.reset;
  useEffect(() => {
    setProblem(null);
    setDone(null);
    resetMutation();
  }, [row, resetMutation]);

  if (!row) return null;
  const what = unlockTypeLabel(row.unlockType, row.sn);
  const owner = rowOwner(row);
  const busy = remove.isPending;
  const blocked = deleteBlockedReason(row, writable);
  const tuyaUserId = row.tuyaUserId;
  const tenancy = row.link ? TENANCY_LABEL[row.link.tenancy] : null;

  const confirm = () => {
    if (!tuyaUserId || busy || blocked) return;
    setProblem(null);
    remove.mutate(
      { deviceId: device.id, unlockType: row.unlockType, unlockNo: row.sn, tuyaUserId },
      {
        onSuccess: (data) => {
          const logPending = data.logPending === true;
          if (data.deleted) {
            setDone({ text: `Đã xoá ${what} (${owner}) trên máy ${device.display_name}.`, logPending });
            return;
          }
          setProblem({ tone: "warn", text: "SmartLife chưa xác nhận đã xoá — đọc lại danh sách để kiểm tra.", logPending });
        },
        onError: (error) =>
          setProblem({
            logPending: isDoorAccessError(error) && error.logPending,
            ...(isDoorAccessError(error) && error.outcomeUnknown
              ? { tone: "warn" as const, text: "Chưa rõ đã xoá chưa — đọc lại danh sách và xem Nhật ký thao tác trước khi thử lại." }
              : { tone: "danger" as const, text: doorErrorMessage(error, "Chưa xoá được trên máy.") }),
          }),
      },
    );
  };

  const close = () => {
    if (done) onDone({ tone: "ok", text: done.text, logPending: done.logPending });
    onClose();
  };

  return (
    <MobileSheet open onClose={close} busy={busy} role="alertdialog" title={done ? `Đã xoá ${what} trên máy` : `Xoá ${what} khỏi máy?`} hideHeader={done !== null}>
      {done ? (
        <div role="status" className="flex flex-col items-center gap-2.5 pb-1 pt-[18px] text-center">
          <span className="grid h-[52px] w-[52px] place-items-center rounded-full bg-[var(--brand-50)] text-[var(--brand)]">
            <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
          </span>
          <p className="m-0 text-lg font-bold">Đã xoá {what} trên máy</p>
          <p className="hint max-w-[300px] text-[13px]">CRM đã bỏ gắn số này khỏi {owner} và ghi vào nhật ký thao tác.</p>
          {done.logPending && <MobileNotice tone="info">Nhật ký thao tác chưa chốt được — kiểm lại ở Quản lý › Nhật ký.</MobileNotice>}
          <button type="button" className="btn btn-primary btn-block mt-2.5" onClick={close}>
            Về Đối chiếu
          </button>
        </div>
      ) : busy ? (
        <div role="status" className="flex flex-col items-center gap-3 pb-[30px] pt-[26px] text-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--brand)] motion-reduce:animate-none" aria-hidden="true" />
          <p className="m-0 text-base font-bold">Đang xoá trên máy…</p>
          <p className="hint">Đừng đóng màn này.</p>
        </div>
      ) : (
        <>
          <div className="kv">
            <div className="kv-row">
              <span>Người gắn</span>
              <span>
                {owner}
                {tenancy ? ` (${tenancy})` : ""}
              </span>
            </div>
            <div className="kv-row">
              <span>Trên máy</span>
              <span>
                {what}
                {row.deviceUserName ? ` · tên «${row.deviceUserName}»` : ""}
              </span>
            </div>
            <div className="kv-row">
              <span>Cửa</span>
              <span>{doorLabel(device)}</span>
            </div>
          </div>
          <MobileNotice tone="danger">Xoá xong, {what} không mở được cửa nữa. Không hoàn tác được — muốn mở lại phải lấy số mới tại máy cửa hoặc app SmartLife.</MobileNotice>
          {problem && <MobileResultNotice result={problem} />}
          {blocked && (
            <p className="hint flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {blocked}.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2.5">
            <button type="button" className="btn btn-ghost" onClick={close}>
              Giữ lại
            </button>
            <button type="button" className="btn btn-danger-solid" disabled={blocked !== null || !tuyaUserId} onClick={confirm}>
              Xoá trên máy
            </button>
          </div>
        </>
      )}
    </MobileSheet>
  );
}
