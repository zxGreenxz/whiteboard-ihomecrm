import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { PersonalAttachments } from "./PersonalAttachments";
import { FinanceSheet } from "./FinanceViews";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  mutationSchema,
  type Snapshot,
  type Receipt,
} from "@/lib/personalFinance/contract";
import { PersonalFinanceError } from "@/lib/personalFinance/service";
import type { PendingRequest } from "@/lib/personalFinance/pendingRequests";
import { usePersonalFinanceMutation } from "@/hooks/personal-finance/usePersonalFinance";
import { defaultPersonalWallet } from '@/lib/quickEntry/personalWallet';
import {
  changedFields,
  deleteReason,
  entityLabel,
  type Editor,
  type Permissions,
} from "./presentation";

type Values = Record<string, string | boolean | string[]>;
const numeric = new Set(["amount", "target", "opening_balance"]);
function initial(editor: Editor, s: Snapshot): Values {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const r = editor.record;
  const values: Record<string, unknown> = {
    name: "",
    icon: editor.entity === "wallet" ? "👛" : "🌱",
    type: "EXPENSE",
    kind: "cash",
    opening_balance: 0,
    hidden: false,
    amount: "",
    target: "",
    txn_date: today,
    description: "",
    attachment_paths: [],
    note: "",
    target_date: "",
    wallet_id:
      editor.entity === 'transaction' ? defaultPersonalWallet(s.wallets) ?? '' : s.wallets.find((w) => w.is_default)?.id ?? s.wallets[0]?.id ?? "",
    source_wallet_id: s.wallets[0]?.id ?? "",
    target_wallet_id: s.wallets[1]?.id ?? "",
    category_id:
      editor.entity === "budget"
        ? ""
        : (s.categories.find((c) => c.type === "EXPENSE" && !c.hidden)?.id ??
          ""),
    ...r,
    ...editor.defaults,
  };
  if (r && editor.entity === "transaction") {
    values.wallet_id = r.resolved_wallet_id;
    values.category_id = r.resolved_category_id ?? "";
  }
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      Array.isArray(v) && k === "attachment_paths"
        ? v.filter((item): item is string => typeof item === "string")
        : typeof v === "boolean"
          ? v
          : String(v ?? ""),
    ]),
  );
}
const fields = {
  wallet: ["name", "kind", "icon", "opening_balance", "hidden"],
  category: ["type", "name", "icon", "hidden"],
  transaction: [
    "type",
    "amount",
    "txn_date",
    "wallet_id",
    "category_id",
    "description",
    "attachment_paths",
  ],
  budget: ["category_id", "amount"],
  goal: ["name", "icon", "target", "target_date", "wallet_id"],
  transfer: [
    "source_wallet_id",
    "target_wallet_id",
    "amount",
    "txn_date",
    "note",
    "goal_id",
  ],
} as const;

function FinanceEditorSession({
  editor: incomingEditor,
  snapshot: s,
  permissions,
  onClose,
  onSaved,
  embedded = false,
  footerAddon,
}: {
  editor: Editor;
  snapshot: Snapshot;
  permissions: Permissions;
  onClose: () => void;
  onSaved?: (r: Receipt) => void;
  embedded?: boolean;
  footerAddon?: ReactNode;
}) {
  const [removing, setRemoving] = useState(false);
  const [closed, setClosed] = useState(false);
  const editor = {
    ...incomingEditor,
    remove: incomingEditor.remove || removing,
  };
  const writer = usePersonalFinanceMutation();
  const [attachmentBlocked, setAttachmentBlocked] = useState(false);
  const attachmentBlockedRef = useRef(false);
  const ownerRef = useRef(s.owner_id);
  ownerRef.current = s.owner_id;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // Closing tears down the uploader at once (abort) and ignores any late save completion.
  const close = () => {
    alive.current = false;
    setClosed(true);
    onClose();
  };
  const [held, setHeld] = useState<PendingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [categoryPicker, setCategoryPicker] = useState(false);
  const [defaults] = useState(() => initial(editor, s));
  const form = useForm<Values>({ defaultValues: defaults });
  const type = String(form.watch("type"));
  const watchedPaths = form.watch("attachment_paths");
  const attachmentPaths = Array.isArray(watchedPaths) ? watchedPaths : [];
  const hasField = (key: string) =>
    fields[editor.entity].some((field) => field === key);
  const title = editor.remove
    ? `Xóa ${entityLabel[editor.entity]}`
    : editor.record &&
        (editor.entity === "transaction" || editor.entity === "transfer")
      ? "Chi tiết giao dịch"
      : editor.entity === "transfer"
        ? "Chuyển tiền giữa ví"
        : `${editor.record ? (permissions.edit ? "Sửa" : "Chi tiết") : "Thêm"} ${entityLabel[editor.entity]}`;
  const allowed = editor.remove
    ? permissions.delete
    : editor.record
      ? permissions.edit &&
        !(editor.entity === "transfer" && editor.record.goal_id)
      : permissions.create;
  const blocked =
    editor.remove && editor.record
      ? deleteReason(editor.entity, editor.record, s)
      : null;
  const busy = writer.isPending;
  const locked = busy || !!held;
  async function submit(values: Values) {
    if (
      closed ||
      !allowed ||
      blocked ||
      attachmentBlockedRef.current ||
      (writer.ownerId && writer.ownerId !== s.owner_id)
    )
      return;
    const submittedOwner = s.owner_id;
    setError(null);
    let request = held;
    try {
      if (!request) {
        const selected = Object.fromEntries(
          fields[editor.entity]
            .filter((k) => k !== "goal_id" || editor.defaults?.goal_id)
            .map((k) => [
              k,
              numeric.has(k)
                ? Number(values[k])
                : k === "target_date" ||
                    (k === "category_id" && editor.entity === "budget")
                  ? values[k] || null
                  : values[k],
            ]),
        );
        const data = editor.remove
          ? {}
          : editor.record
            ? changedFields(
                Object.fromEntries(
                  Object.keys(selected).map((k) => [
                    k,
                    numeric.has(k)
                      ? Number(defaults[k])
                      : k === "target_date" ||
                          (k === "category_id" && editor.entity === "budget")
                        ? defaults[k] || null
                        : defaults[k],
                  ]),
                ),
                selected,
              )
            : selected;
        // Arrays differ by reference; an unchanged image list must not be sent with a notes edit.
        if (
          editor.record &&
          editor.entity === "transaction" &&
          JSON.stringify(selected.attachment_paths) ===
            JSON.stringify(defaults.attachment_paths)
        )
          delete data.attachment_paths;
        if (!editor.remove && editor.record && !Object.keys(data).length) {
          close();
          return;
        }
        const parsed = mutationSchema.safeParse({
          action: `${editor.entity}.${editor.remove ? "delete" : editor.record ? "update" : "create"}`,
          ...(editor.record
            ? { id: editor.record.id, expected_version: editor.record.version }
            : {}),
          data,
        });
        if (!parsed.success) {
          setError(
            "Kiểm tra thông tin: tên không để trống; số tiền mới phải là số nguyên từ 1 đến 1.000 tỷ; ngày và ví phải hợp lệ.",
          );
          return;
        }
        request = writer.prepare(parsed.data);
      }
      const receipt = await writer.mutateAsync(request);
      if (!alive.current || ownerRef.current !== submittedOwner) return;
      setHeld(null);
      onSaved?.(receipt);
      close();
    } catch (e) {
      if (!alive.current || ownerRef.current !== submittedOwner) return;
      if (e instanceof PersonalFinanceError && e.outcomeUnknown && request)
        setHeld(request);
      else setHeld(null);
      setError(
        e instanceof Error ? e.message : "Không thể lưu. Vui lòng thử lại.",
      );
    }
  }
  const input = (key: string, label: string, type = "text") => (
    <label className="pf-field" key={key}>
      {label}
      {key === "amount" && (
        <span className="pf-amount-currency" aria-hidden="true">
          ₫
        </span>
      )}
      <input
        aria-label={label}
        placeholder={key === "amount" ? "0" : undefined}
        inputMode={key === "amount" ? "decimal" : undefined}
        type={type}
        step="any"
        {...form.register(key)}
      />
    </label>
  );
  const select = (
    key: string,
    label: string,
    options: Array<[string, string]>,
  ) => (
    <label className="pf-field" key={key}>
      {label}
      <select
        aria-label={label}
        disabled={key === "target_wallet_id" && !!editor.defaults?.goal_id}
        {...form.register(key)}
        value={String(form.watch(key) ?? "")}
        onChange={(e) => {
          form.setValue(key, e.target.value);
          if (key === "type")
            form.setValue(
              "category_id",
              s.categories.find((c) => c.type === e.target.value && !c.hidden)
                ?.id ?? "",
            );
        }}
      >
        {options.map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
  const wallets = s.wallets.map(
    (w) =>
      [w.id, `${w.name}${w.hidden ? " (ẩn tổng quan)" : ""}`] as [
        string,
        string,
      ],
  );
  const categoryType = editor.entity === "budget" ? "EXPENSE" : type;
  const categories = s.categories
    .filter(
      (c) =>
        c.type === categoryType && (!c.hidden || c.id === defaults.category_id),
    )
    .map(
      (c) =>
        [c.id, `${c.name}${c.hidden ? " (đã ẩn)" : ""}`] as [string, string],
    );
  const content = (
    <form onSubmit={form.handleSubmit(submit)} className="pf-form">
      <fieldset disabled={locked || !allowed}>
        {editor.remove ? (
          <p>
            {blocked ??
              `Bạn muốn xóa ${String(editor.record?.name ?? entityLabel[editor.entity])}?`}
          </p>
        ) : (
          <>
            {hasField("type") && (
              <div className="pf-pills pf-editor-types">
                {[
                  ["EXPENSE", "− Chi tiêu"],
                  ["INCOME", "+ Thu nhập"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={type === value ? "active" : ""}
                    aria-pressed={type === value}
                    onClick={() => {
                      form.setValue("type", value);
                      form.setValue(
                        "category_id",
                        s.categories.find((c) => c.type === value && !c.hidden)
                          ?.id ?? "",
                      );
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {hasField("name") &&
              input("name", `Tên ${entityLabel[editor.entity]}`)}
            {editor.entity === "wallet" &&
              select("kind", "Loại ví", [
                ["cash", "Tiền mặt"],
                ["bank", "Ngân hàng"],
                ["ewallet", "Ví điện tử"],
                ["saving", "Tiết kiệm"],
                ["other", "Khác"],
              ])}
            {hasField("icon") && (
              <div className="pf-field">
                <span>Chọn biểu tượng</span>
                <div className="pf-emoji-options">
                  {[
                    ...new Set([
                      String(form.watch("icon")),
                      ...(editor.entity === "wallet"
                        ? ["🏦", "👛", "🌱", "📱", "💳", "💵", "🪙", "🎯"]
                        : [
                            "🏷️",
                            "🍜",
                            "☕",
                            "🏠",
                            "🐾",
                            "🎁",
                            "🌱",
                            "💼",
                            "🧘",
                            "🚗",
                            "💻",
                          ]),
                    ]),
                  ].map((icon) => (
                    <button
                      key={icon}
                      type="button"
                      aria-label={`Biểu tượng ${icon}`}
                      aria-pressed={form.watch("icon") === icon}
                      onClick={() => form.setValue("icon", icon)}
                    >
                      {icon}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {editor.entity === "wallet" && (
              <>
                {input("opening_balance", "Số dư ban đầu", "number")}
                <p className="pf-muted">
                  Số dư ban đầu không tính vào thu nhập.
                </p>
              </>
            )}
            {hasField("amount") &&
              input(
                "amount",
                editor.entity === "budget" ? "Hạn mức mỗi tháng" : "Số tiền",
                "number",
              )}
            {editor.entity === "goal" && (
              <>
                {input("target", "Số tiền mục tiêu", "number")}
                {input("target_date", "Ngày mục tiêu", "date")}
              </>
            )}
            {hasField("txn_date") &&
              editor.entity !== "transaction" &&
              input(
                "txn_date",
                editor.entity === "transfer" ? "Ngày chuyển" : "Ngày giao dịch",
                "date",
              )}
            {hasField("wallet_id") &&
              editor.entity !== "transaction" &&
              select(
                "wallet_id",
                editor.entity === "goal" ? "Ví tích lũy" : "Ví thanh toán",
                wallets,
              )}
            {editor.entity === "transfer" && (
              <>
                {select("source_wallet_id", "Ví chuyển", wallets)}
                {select("target_wallet_id", "Ví nhận", wallets)}
                {editor.defaults?.goal_id && (
                  <p className="pf-muted">
                    Khoản góp chuyển tiền thực giữa hai ví và được giữ nguyên
                    trong lịch sử.
                  </p>
                )}
              </>
            )}
            {hasField("category_id") && (
              <>
                <div className="pf-field">
                  <span>Danh mục</span>
                  <button
                    className="pf-select-category"
                    type="button"
                    aria-label="Chọn danh mục"
                    onClick={() => setCategoryPicker(true)}
                  >
                    <span>
                      {
                        s.categories.find(
                          (c) => c.id === form.watch("category_id"),
                        )?.icon
                      }{" "}
                      {s.categories.find(
                        (c) => c.id === form.watch("category_id"),
                      )?.name ??
                        (editor.entity === "budget"
                          ? "Tổng chi tiêu"
                          : "Chọn danh mục")}
                    </span>
                    <span>⌄</span>
                  </button>
                </div>
              </>
            )}
            {editor.entity === "transaction" && (
              <div className="pf-two-cols">
                {select("wallet_id", "Ví thanh toán", [["", "Chọn ví"], ...wallets])}
                {input("txn_date", "Ngày giao dịch", "date")}
              </div>
            )}
            {hasField("description") && input("description", "Ghi chú")}
            {editor.entity === "transfer" && input("note", "Ghi chú")}
            {hasField("hidden") && (
              <label className="pf-check">
                <input type="checkbox" {...form.register("hidden")} />{" "}
                {editor.entity === "wallet"
                  ? "Ẩn khỏi tổng quan"
                  : "Ẩn khỏi lựa chọn mới"}
              </label>
            )}
          </>
        )}
      </fieldset>
      {editor.entity === "transaction" && !editor.remove && !closed && (
        <PersonalAttachments
          key={`${s.owner_id}/${editor.record?.id ?? "new"}`}
          ownerId={s.owner_id}
          instanceKey={String(editor.record?.id ?? "new")}
          paths={attachmentPaths}
          editable={allowed && !locked}
          onChange={(paths) => form.setValue("attachment_paths", paths)}
          onBlockedChange={(value) => {
            attachmentBlockedRef.current = value;
            setAttachmentBlocked(value);
          }}
        />
      )}
      {editor.record &&
        !editor.remove &&
        deleteReason(editor.entity, editor.record, s) && (
          <p className="pf-muted pf-delete-reason">
            {deleteReason(editor.entity, editor.record, s)}
          </p>
        )}
      {error && (
        <p role="alert" className="pf-error">
          {error}
          {held && " Yêu cầu đã khóa. Gửi lại y nguyên để xác nhận."}
        </p>
      )}
      {footerAddon}
      <div className="pf-form-actions">
        {editor.record && !editor.remove && permissions.delete && (
          <Button
            type="button"
            variant="destructive"
            disabled={locked || !!deleteReason(editor.entity, editor.record, s)}
            title={deleteReason(editor.entity, editor.record, s) ?? undefined}
            onClick={() => {
              if (!locked) setRemoving(true);
            }}
          >
            Xóa {entityLabel[editor.entity]}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={close}
        >
          Hủy
        </Button>
        {allowed && !blocked && (
          <Button type="submit" disabled={closed || busy || attachmentBlocked}>
            {busy
              ? "Đang lưu…"
              : held
                ? "Gửi lại y nguyên"
                : editor.remove
                  ? "Xác nhận xóa"
                  : editor.record
                    ? "Lưu thay đổi"
                    : editor.entity === "transfer"
                      ? "Chuyển tiền"
                      : editor.entity === "transaction"
                        ? "Lưu giao dịch"
                        : "Lưu"}
          </Button>
        )}
      </div>
    </form>
  );
  const pickerContent = categoryPicker && !inline && (
    <>
      <h3>{embedded ? "Chọn danh mục" : ""}</h3>
      <div className="pf-category-grid">
        {(editor.entity === "budget"
          ? [["", "Tổng chi tiêu"], ...categories]
          : categories
        ).map(([id, name]) => (
          <button
            type="button"
            key={id}
            className="pf-category-detail"
            aria-pressed={form.watch("category_id") === id}
            onClick={() => {
              form.setValue("category_id", id);
              setCategoryPicker(false);
            }}
          >
            <span className="pf-emoji">
              {s.categories.find((c) => c.id === id)?.icon ?? "🏷️"}
            </span>
            <span>{name}</span>
          </button>
        ))}
      </div>
      <div className="pf-form-actions">
        <Button variant="outline" onClick={() => setCategoryPicker(false)}>
          Quay lại
        </Button>
        {permissions.create && (
          <Button onClick={() => setInline(true)}>Thêm danh mục</Button>
        )}
      </div>
    </>
  );
  const editorContent = (
    <>
      <div hidden={categoryPicker || inline}>{content}</div>
      {pickerContent}
      {inline && (
        <FinanceEditor
          embedded
          editor={{ entity: "category", defaults: { type: categoryType } }}
          snapshot={s}
          permissions={permissions}
          onClose={() => setInline(false)}
          onSaved={(r) => {
            const id = r.entities[0]?.id;
            if (id) {
              form.setValue("category_id", id);
              setCategoryPicker(false);
            }
          }}
        />
      )}
    </>
  );
  return embedded ? (
    editorContent
  ) : (
    <FinanceSheet
      open
      title={
        inline ? "Thêm danh mục" : categoryPicker ? "Chọn danh mục" : title
      }
      onClose={() => {
        if (!busy) {
          if (inline) setInline(false);
          else if (categoryPicker) setCategoryPicker(false);
          else close();
        }
      }}
    >
      {editorContent}
    </FinanceSheet>
  );
}

// Owner/entity/record changes start a fresh session: uploads, held requests and closing state never carry over.
export function FinanceEditor(
  props: ComponentProps<typeof FinanceEditorSession>,
) {
  return (
    <FinanceEditorSession
      key={`${props.snapshot.owner_id}:${props.editor.entity}:${props.editor.record?.id ?? "new"}`}
      {...props}
    />
  );
}
