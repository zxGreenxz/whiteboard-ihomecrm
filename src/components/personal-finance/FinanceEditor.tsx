import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  mutationSchema,
  type Snapshot,
  type Receipt,
} from "@/lib/personalFinance/contract";
import { PersonalFinanceError } from "@/lib/personalFinance/service";
import type { PendingRequest } from "@/lib/personalFinance/pendingRequests";
import { usePersonalFinanceMutation } from "@/hooks/personal-finance/usePersonalFinance";
import {
  changedFields,
  deleteReason,
  entityLabel,
  type Editor,
  type Permissions,
} from "./presentation";

type Values = Record<string, string | boolean>;
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
    note: "",
    target_date: "",
    wallet_id:
      s.wallets.find((w) => w.is_default)?.id ?? s.wallets[0]?.id ?? "",
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
      typeof v === "boolean" ? v : String(v ?? ""),
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

export function FinanceEditor({
  editor,
  snapshot: s,
  permissions,
  onClose,
  onSaved,
}: {
  editor: Editor;
  snapshot: Snapshot;
  permissions: Permissions;
  onClose: () => void;
  onSaved?: (r: Receipt) => void;
}) {
  const writer = usePersonalFinanceMutation();
  const [held, setHeld] = useState<PendingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inline, setInline] = useState(false);
  const [defaults] = useState(() => initial(editor, s));
  const form = useForm<Values>({ defaultValues: defaults });
  const type = String(form.watch("type"));
  const hasField = (key: string) =>
    fields[editor.entity].some((field) => field === key);
  const title = `${editor.remove ? "Xóa" : editor.record ? "Sửa" : "Thêm"} ${entityLabel[editor.entity]}`;
  const allowed = editor.remove
    ? permissions.delete
    : editor.record
      ? permissions.edit
      : permissions.create;
  const blocked =
    editor.remove && editor.record
      ? deleteReason(editor.entity, editor.record, s)
      : null;
  const busy = writer.isPending;
  const locked = busy || !!held;
  async function submit(values: Values) {
    if (!allowed || blocked) return;
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
        if (!editor.remove && editor.record && !Object.keys(data).length) {
          onClose();
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
      setHeld(null);
      onSaved?.(receipt);
      onClose();
    } catch (e) {
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
      <input
        aria-label={label}
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
        disabled={key === 'target_wallet_id' && !!editor.defaults?.goal_id}
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
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose();
        }}
      >
        <DialogContent className="pf-dialog">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {editor.remove
                ? "Xác nhận thay đổi. Lịch sử liên kết được bảo vệ."
                : "Thông tin chỉ thuộc ví cá nhân của bạn."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(submit)} className="pf-form">
            <fieldset disabled={locked || !allowed}>
              {editor.remove ? (
                <p>
                  {blocked ??
                    `Bạn muốn xóa ${String(editor.record?.name ?? entityLabel[editor.entity])}?`}
                </p>
              ) : (
                <>
                  {hasField("type") &&
                    select("type", "Loại", [
                      ["EXPENSE", "Chi tiêu"],
                      ["INCOME", "Thu nhập"],
                    ])}
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
                  {hasField("icon") && input("icon", "Biểu tượng")}
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
                      editor.entity === "budget"
                        ? "Hạn mức mỗi tháng"
                        : "Số tiền",
                      "number",
                    )}
                  {editor.entity === "goal" && (
                    <>
                      {input("target", "Số tiền mục tiêu", "number")}
                      {input("target_date", "Ngày mục tiêu", "date")}
                    </>
                  )}
                  {hasField("txn_date") && input("txn_date", "Ngày", "date")}
                  {hasField("wallet_id") &&
                    select(
                      "wallet_id",
                      editor.entity === "goal" ? "Ví tích lũy" : "Ví",
                      wallets,
                    )}
                  {editor.entity === "transfer" && (
                    <>
                      {select("source_wallet_id", "Ví gửi", wallets)}
                      {select("target_wallet_id", "Ví nhận", wallets)}
                      {editor.defaults?.goal_id && (
                        <p className="pf-muted">
                          Khoản góp chuyển tiền thực giữa hai ví và được giữ
                          nguyên trong lịch sử.
                        </p>
                      )}
                    </>
                  )}
                  {hasField("category_id") && (
                    <>
                      {select(
                        "category_id",
                        "Danh mục",
                        editor.entity === "budget"
                          ? [["", "Tổng chi tiêu"], ...categories]
                          : categories,
                      )}
                      {permissions.create && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setInline(true)}
                        >
                          Thêm danh mục ngay
                        </Button>
                      )}
                    </>
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
            {error && (
              <p role="alert" className="pf-error">
                {error}
                {held && " Yêu cầu đã khóa. Gửi lại y nguyên để xác nhận."}
              </p>
            )}
            <div className="pf-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                Đóng
              </Button>
              {allowed && !blocked && (
                <Button type="submit" disabled={busy}>
                  {busy
                    ? "Đang lưu…"
                    : held
                      ? "Gửi lại y nguyên"
                      : editor.remove
                        ? "Xác nhận xóa"
                        : "Lưu"}
                </Button>
              )}
            </div>
          </form>
        </DialogContent>
      </Dialog>
      {inline && (
        <FinanceEditor
          editor={{ entity: "category", defaults: { type: categoryType } }}
          snapshot={s}
          permissions={permissions}
          onClose={() => setInline(false)}
          onSaved={(r) => {
            const id = r.entities[0]?.id;
            if (id) form.setValue("category_id", id);
          }}
        />
      )}
    </>
  );
}
