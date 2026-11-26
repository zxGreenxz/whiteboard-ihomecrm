import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAccounts } from "@/hooks/useAccounts";
import { useBuildings } from "@/hooks/useBuildings";
import {
  useHousePool,
  useHousePoolWrite,
  useHousePoolRecovery,
  type HousePoolWrite,
} from "@/hooks/profit-ledger/useHousePool";
import type { SharedFundState } from "@/hooks/profit-ledger/useSharedFund";
import { formatVND } from "@/lib/utils";
import { todayISO } from "@/lib/collect";

const selectClass = "h-10 w-full rounded-md border bg-background px-2";
const statuses = {
  PAID: "Đã ghi sổ",
  RESERVED: "Đang dành để hoàn",
  RELEASED: "Đã giải phóng",
};
function message(error: unknown) {
  return error && typeof error === "object" && "message" in error
    ? String(error.message)
    : "Chưa xác nhận được giao dịch. Tải lại sổ để đối chiếu.";
}

export default function HousePoolPanel({
  org,
  shareholders,
  enabled,
}: {
  org: string;
  shareholders: SharedFundState["shareholders"];
  enabled: boolean;
}) {
  const [percentage, setPercentage] = useState("100");
  const rate = /^\d{1,3}(?:[.,]\d{1,2})?$/.test(percentage)
    ? Math.round(Number(percentage.replace(",", ".")) * 100)
    : 0;
  const validRate = rate >= 1 && rate <= 10000;
  const query = useHousePool(org, validRate ? rate : 10000);
  const write = useHousePoolWrite(org);
  const recover = useHousePoolRecovery(org);
  const [partner, setPartner] = useState("");
  const [account, setAccount] = useState("");
  const [day, setDay] = useState(todayISO);
  const [review, setReview] = useState<HousePoolWrite | null>(null);
  const [feedback, setFeedback] = useState("");
  const [voucher, setVoucher] = useState<string | null>(null);
  const data = query.data;
  const buildings = useBuildings({
    enabled: enabled && !!data && data.rules.length === 0,
  });
  const accounts = useAccounts({
    enabled: enabled && !!data && data.rules.length > 0,
  });
  if (query.isError)
    return (
      <div role="alert">
        {message(query.error)}{" "}
        <Button variant="link" onClick={() => void query.refetch()}>
          Tải lại quỹ góp
        </Button>
      </div>
    );
  if (!data) return <p role="status">Đang đọc quỹ góp theo nhà…</p>;
  const configured = data.rules.length > 0;
  const rules = [
    { name: "15KV", percent: 44 },
    { name: "417LVT", percent: 45 },
  ].flatMap((target) => {
    const matches = (buildings.data ?? []).filter(
      (b) => b.organization_id === org && b.name === target.name,
    );
    const baseline = data.baselines.find(
      (v) => v.building_id === matches[0]?.id,
    );
    return matches.length === 1 && baseline
      ? [
          {
            building_id: matches[0].id,
            share_percent: target.percent,
            retained_percent: 1,
            baseline_revision: baseline.id,
          },
        ]
      : [];
  });
  const confirm = async () => {
    if (!review || write.isPending) return;
    if (
      review.kind === "return" &&
      (query.isFetching ||
        !data.quote.eligible ||
        data.quote.hash !== review.hash)
    ) {
      setReview(null);
      setFeedback("Số quỹ đã đổi. Kiểm tra lại phần của từng người.");
      return;
    }
    try {
      const result = await write.mutateAsync(review);
      setVoucher(result.voucher);
      setReview(null);
      setFeedback(
        result.voucher
          ? "Đã lập một phiếu chi cho cả đợt. Phiếu đang chờ duyệt và ghi sổ."
          : "Đã kích hoạt quy tắc. Số kỳ-nhà vừa chuyển vào quỹ: " +
              result.imported +
              ".",
      );
    } catch (error) {
      setFeedback(message(error));
      void query.refetch();
    }
  };
  return (
    <section
      className="grid gap-3 rounded-lg border p-4 text-sm"
      aria-label="Quỹ góp theo nhà"
    >
      {configured ? (
        <>
          <div>
            <p className="text-muted-foreground">Phần góp còn trong quỹ</p>
            <strong className="text-xl">
              {formatVND(
                data.quote.lines.reduce((sum, l) => sum + l.available, 0),
              )}
            </strong>
          </div>
          <div className="space-y-1">
            {data.opening?.linked && (
              <p>
                Số mở sổ ngày {data.opening.date.split("-").reverse().join("/")}{" "}
                · {formatVND(data.opening.amount)} · mỗi người{" "}
                {formatVND(data.opening.amount / 2)}
              </p>
            )}
            {data.rules.map((r) => (
              <p key={r.building_id}>
                {r.name} · góp {r.share_percent * 2}% · giữ riêng{" "}
                {r.retained_percent}% từ tháng 6/2026. Tháng 5/2026 giữ riêng
                0%.
              </p>
            ))}
          </div>
          <div className="divide-y">
            {data.quote.lines.map((l) => (
              <div key={l.shareholder_id} className="py-2">
                <strong>{l.name}</strong> · còn {formatVND(l.available)}
                <p className="text-muted-foreground">
                  Đã góp {formatVND(l.contributed)} · đang dành{" "}
                  {formatVND(l.reserved)} · đã trả {formatVND(l.paid)}
                </p>
              </div>
            ))}
          </div>
          {enabled && !review && (
            <>
              <label>
                Tỷ lệ hoàn cho toàn bộ người góp (%)
                <Input
                  inputMode="decimal"
                  value={percentage}
                  onChange={(e) => setPercentage(e.target.value)}
                />
              </label>
              <label>
                Sổ tiền thực chi
                <select
                  className={selectClass}
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">Chọn sổ tiền</option>
                  {(accounts.data ?? [])
                    .filter((b) => b.organization_id === org && !b.is_virtual)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </label>
              {accounts.isError && (
                <p role="alert">{message(accounts.error)}</p>
              )}
              <label>
                Ngày phiếu
                <Input
                  type="date"
                  value={day}
                  min={data.min_date ?? undefined}
                  max={todayISO()}
                  onChange={(e) => setDay(e.target.value)}
                />
              </label>
              <Button
                disabled={
                  !validRate ||
                  query.isFetching ||
                  !data.quote.eligible ||
                  !account ||
                  !day ||
                  (!!data.min_date && day < data.min_date) ||
                  day > todayISO()
                }
                onClick={() => {
                  setFeedback("");
                  setVoucher(null);
                  setReview({
                    kind: "return",
                    rate,
                    account,
                    date: day,
                    hash: data.quote.hash,
                    total: data.quote.total,
                  });
                }}
              >
                Xem trước đợt hoàn
              </Button>
            </>
          )}
          <details>
            <summary>Lịch sử góp theo kỳ ({data.history.length})</summary>
            {data.history.map((h) => (
              <p className="mt-2" key={h.id}>
                {h.month.slice(0, 7)} · {h.building} · mỗi người{" "}
                {formatVND(h.each)} · giữ riêng {formatVND(h.retained)}
              </p>
            ))}
          </details>
          <details>
            <summary>Các đợt hoàn ({data.batches.length})</summary>
            {data.batches.map((b) => (
              <article key={b.id} className="my-2 border-t pt-2">
                <a
                  className="underline"
                  href={"/income-expense/voucher/" + b.voucher_id}
                >
                  {b.code ?? "Mở phiếu"}
                </a>{" "}
                · {statuses[b.state]} · {b.rate / 100}% · {formatVND(b.total)}
                {b.lines.map((l) => (
                  <p key={l.name}>
                    {l.name} · {formatVND(l.amount)}
                  </p>
                ))}
              </article>
            ))}
          </details>
        </>
      ) : enabled && !review ? (
        <>
          <p>
            Từ tháng 5 đến tháng 10/2026, lấy số đã chốt. Từ tháng 11/2026, tự
            gom khi chốt kỳ. Bạn và cổ đông cùng góp mỗi người 44% ở 15KV, 45% ở
            417LVT. Tháng 5 giữ riêng 0%. Từ tháng 6, mỗi nhà giữ riêng 1%.
          </p>
          <label>
            Cổ đông cùng góp với bạn
            <select
              className={selectClass}
              value={partner}
              onChange={(e) => setPartner(e.target.value)}
            >
              <option value="">Chọn cổ đông</option>
              {shareholders.map((s) => (
                <option key={s.shareholder_id} value={s.shareholder_id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          {buildings.isError && <p role="alert">{message(buildings.error)}</p>}
          {!buildings.isLoading && !buildings.isError && rules.length !== 2 && (
            <p role="status">Chưa xác định được đúng hai nhà trong công ty.</p>
          )}
          <Button
            disabled={rules.length !== 2 || !partner}
            onClick={() => {
              setFeedback("");
              setReview({
                kind: "activate",
                partner,
                rules,
                opening: data.opening?.amount ? data.opening.id : null,
              });
            }}
          >
            Xem trước cấu hình
          </Button>
        </>
      ) : !enabled ? (
        <p>Sổ đang ở chế độ chỉ xem.</p>
      ) : null}
      {review && (
        <div className="grid gap-2 border-t pt-3">
          {review.kind === "return" ? (
            <>
              <strong>
                Hoàn {review.rate / 100}% cho tất cả người góp ·{" "}
                {formatVND(review.total)}
              </strong>
              {data.quote.lines.map((l) => (
                <p key={l.shareholder_id}>
                  {l.name} nhận {formatVND(l.amount)}
                </p>
              ))}
              <p>
                Một phiếu chi ghi toàn bộ người nhận. Cả đợt được đánh dấu đã
                trả khi phiếu được ghi sổ.
              </p>
            </>
          ) : (
            <p>
              Xác nhận bạn và{" "}
              <strong>
                {
                  shareholders.find((s) => s.shareholder_id === review.partner)
                    ?.name
                }
              </strong>{" "}
              cùng góp. CRM ghi phần của hai người ở cả hai nhà từ tháng 5 đến
              tháng 10/2026, gồm cả kỳ lỗ, rồi tự gom khi chốt kỳ mới.
              {review.opening && data.opening && (
                <>
                  {" "}
                  Số mở sổ {data.opening.reference} là{" "}
                  {formatVND(data.opening.amount)}. Mỗi người nhận phần góp{" "}
                  {formatVND(data.opening.amount / 2)} từ số này.
                </>
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={write.isPending || query.isFetching}
              onClick={() => void confirm()}
            >
              {write.isPending
                ? "Đang ghi…"
                : review.kind === "return"
                  ? "Lập phiếu hoàn toàn bộ người góp"
                  : "Kích hoạt và chuyển các kỳ đã chốt"}
            </Button>
            <Button
              variant="outline"
              disabled={write.isPending}
              onClick={() => setReview(null)}
            >
              Quay lại
            </Button>
          </div>
        </div>
      )}
      {enabled && (
        <Button
          variant="link"
          disabled={recover.isPending || write.isPending}
          onClick={async () => {
            try {
              const prior = await recover.mutateAsync();
              setVoucher(prior?.voucher ?? null);
              setReview(null);
              setFeedback(
                prior
                  ? "Đã tìm thấy biên nhận của lần ghi trước."
                  : "Không có lần ghi đang chờ đối chiếu.",
              );
            } catch (error) {
              setFeedback(message(error));
            }
          }}
        >
          Đối chiếu lần gửi trước
        </Button>
      )}
      {feedback && <p role="status">{feedback}</p>}
      {voucher && (
        <a className="underline" href={"/income-expense/voucher/" + voucher}>
          Mở phiếu chi của cả đợt
        </a>
      )}
    </section>
  );
}
