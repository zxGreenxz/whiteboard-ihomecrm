import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  readPoolExpenseCsv,
  usePoolExpenseLink,
  type PoolExpenseItem,
} from "@/hooks/profit-ledger/useHousePool";
import { formatVND } from "@/lib/utils";

export default function HousePoolExpenseLink({
  org,
  available,
}: {
  org: string;
  available: number;
}) {
  const link = usePoolExpenseLink(org);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<{
    items: PoolExpenseItem[];
    before: number;
    after: number;
    amount: number;
  } | null>(null);
  function report(error: unknown) {
    setNote(
      typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "Chưa đọc được kết quả. Chọn lại cùng tệp để đối chiếu.",
    );
  }
  async function inspect(file: File) {
    setBusy(true);
    setNote("");
    setPreview(null);
    try {
      const items = await readPoolExpenseCsv(file);
      const result = await link.mutateAsync({
        items,
        before: available,
        apply: false,
      });
      if (result.linked)
        setNote(
          "Đã liên kết đủ " +
            result.count +
            " phiếu. Số quỹ hiện tại " +
            formatVND(result.after) +
            ".",
        );
      else
        setPreview({
          items,
          before: available,
          amount: result.amount,
          after: result.after,
        });
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview || busy) return;
    setBusy(true);
    setNote("");
    try {
      const result = await link.mutateAsync({ ...preview, apply: true });
      setPreview(null);
      setNote(
        "Đã liên kết " +
          result.count +
          " phiếu gốc. Quỹ còn " +
          formatVND(result.after) +
          ".",
      );
    } catch (error) {
      report(error);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded border p-3">
      <summary>Ghi giảm theo phiếu chi đã ghi sổ</summary>
      <label className="mt-3 block">
        Danh sách phiếu đã chọn (CSV)
        <input
          className="mt-2 block w-full"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void inspect(file);
          }}
        />
      </label>
      {preview && (
        <div className="mt-3 grid gap-2">
          <p>
            {preview.items.length} phiếu gốc · ghi giảm{" "}
            {formatVND(preview.amount)} · quỹ còn {formatVND(preview.after)}.
          </p>
          <Button onClick={() => void apply()} disabled={busy}>
            Ghi giảm và liên kết phiếu gốc
          </Button>
        </div>
      )}
      {busy && <p role="status">Đang đối chiếu…</p>}
      {note && <p role="status">{note}</p>}
    </details>
  );
}
