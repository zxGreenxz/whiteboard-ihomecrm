import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { formatVND } from '@/lib/utils';
import { FinancialWorkflowError, workflowErrorMessage } from '@/lib/financialWorkflow';
import {
  useSharedFund,
  useSharedFundWrite,
  type FundWrite,
  type SharedFundState,
} from '@/hooks/profit-ledger/useSharedFund';
import SharedFundForm, { sourceLabels, type FundAction } from './SharedFundForm';
import HousePoolPanel from './HousePoolPanel';

const date = (v: string) => v.slice(0, 10).split('-').reverse().join('/');
const names = (state: SharedFundState, id: string) =>
  state.shareholders.find((p) => p.shareholder_id === id)?.name ?? id;

function Review({ op, state }: { op: FundWrite; state: SharedFundState }) {
  if (op.action === 'opening')
    return (
      <p>
        Mở mốc cho <strong>{names(state, op.shareholderId)}</strong> đến hết kỳ {op.throughMonth.slice(0, 7)}.{' '}
        Ứng dư chuyển sang {formatVND(op.advance)} theo đối chiếu ngày {date(op.asOfDate)}. Ứng đã duyệt còn
        dư trước khi mở mốc: {formatVND(op.expectedApproved)}. Lợi nhuận chưa chi hiện tại:{' '}
        {formatVND(op.expectedUnpaid)}.
      </p>
    );
  if (op.action === 'source')
    return (
      <p>
        {sourceLabels[op.kind]} ngày {date(op.effectiveDate)} theo {op.reference}:{' '}
        <strong>{formatVND(op.amount)}</strong>. Quỹ sau ghi nhận{' '}
        {formatVND(op.expected + (op.kind === 'DEBIT' ? -op.amount : op.amount))}.
      </p>
    );
  const total = op.lines.reduce((n, r) => n + r.amount, 0);
  return (
    <>
      <p>
        Phân bổ <strong>{formatVND(total)}</strong> ngày {date(op.effectiveDate)} theo {op.reference}. Quỹ còn{' '}
        {formatVND(op.expected - total)}.
      </p>
      <ul className="list-disc pl-5">
        {op.lines.map((r) => (
          <li key={r.shareholder_id}>
            {names(state, r.shareholder_id)} · phần chia {formatVND(r.amount)} · cấn ứng{' '}
            {formatVND(r.advance_offset_amount)} · phải trả {formatVND(r.amount - r.advance_offset_amount)}
          </li>
        ))}
      </ul>
    </>
  );
}

function FundHistory({ state, onSettle }: { state: SharedFundState; onSettle: (id: string) => void }) {
  return (
    <div className="grid gap-2 text-sm">
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Lịch sử nguồn quỹ ({state.sources.length})</summary>
        {!state.sources.length && <p className="mt-2">Chưa ghi nguồn quỹ.</p>}
        {state.sources.map((r) => (
          <article key={r.id} className="mt-2 border-t pt-2">
            <div>
              {date(r.effective_date)} · {sourceLabels[r.kind]} · {formatVND(r.amount)}
            </div>
            <div className="break-words text-muted-foreground">
              {r.reference} · {r.evidence}
            </div>
          </article>
        ))}
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">
          Quyết định phân bổ ({state.distributions.length})
        </summary>
        {!state.distributions.length && <p className="mt-2">Chưa có quyết định phân bổ.</p>}
        {state.distributions.some((d) => d.payable_amount > 0) && (
          <p className="mt-2 text-muted-foreground">
            Màn chốt chi sẽ tính toàn bộ lợi nhuận chưa chi đến kỳ chọn và các khoản ứng còn dư hiện tại của
            cổ đông.
          </p>
        )}
        {state.distributions.map((d) => (
          <article key={d.id} className="mt-2 border-t pt-2">
            <p className="font-medium">
              {date(d.effective_date)} · {d.reference} · {formatVND(d.amount)}
            </p>
            <p className="break-words text-muted-foreground">{d.evidence}</p>
            <ul className="mt-1 space-y-1">
              {d.lines.map((l) => (
                <li key={l.shareholder_id}>
                  {l.name} · phần chia {formatVND(l.amount)} · cấn ứng {formatVND(l.advance_offset_amount)} ·
                  phải trả khi phân bổ {formatVND(l.payable_amount)}
                  {l.payable_amount > 0 && (
                    <Button type="button" variant="link" size="sm" onClick={() => onSettle(l.shareholder_id)}>
                      Xem chốt chi hiện tại
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Mốc ứng lịch sử ({state.openings.length})</summary>
        {!state.openings.length && <p className="mt-2">Chưa ghi mốc ứng lịch sử.</p>}
        {state.openings.map((o) => (
          <article key={o.opening_id} className="mt-2 border-t pt-2">
            {names(state, o.shareholder_id)} · hết kỳ {o.through_month.slice(0, 7)} · ứng dư{' '}
            {formatVND(o.advance_amount)}
            <p className="break-words text-muted-foreground">
              Đối chiếu {date(o.as_of_date)} · {o.evidence}. Đã tính {o.reconciled_count} phiếu CRM, tổng{' '}
              {formatVND(o.reconciled_approved)}.
            </p>
          </article>
        ))}
      </details>
    </div>
  );
}

export default function SharedFundPanel({ org, onSettle }: { org: string; onSettle: (id: string) => void }) {
  const query = useSharedFund(org),
    write = useSharedFundWrite(org);
  const [action, setAction] = useState<FundAction | null>(null),
    [showHousePool, setShowHousePool] = useState(false),
    [review, setReview] = useState<FundWrite | null>(null);
  const [notice, setNotice] = useState(''),
    [issue, setIssue] = useState(''),
    [unknown, setUnknown] = useState(false);
  const state = query.data;
  if (query.isLoading) return <p role="status">Đang tải nguồn quỹ, cổ đông và quyết định…</p>;
  if (query.isError || !state || state.organization_id !== org)
    return (
      <div role="alert">
        <p>
          {(query.error as { code?: string } | null)?.code === '42501'
            ? 'Bạn không có quyền xem quỹ chung của công ty.'
            : 'Chưa tải được sổ quỹ chung của công ty.'}
        </p>
        <Button type="button" variant="outline" onClick={() => void query.refetch()}>
          Tải lại sổ quỹ
        </Button>
      </div>
    );
  const enabled = state.route === 'CANONICAL';
  const choose = (a: FundAction | null) => {
    setAction(a);
    setReview(null);
    setNotice('');
    setIssue('');
    setUnknown(false);
  };
  const confirm = async () => {
    if (!review || write.isPending || !enabled) return;
    try {
      const receipt = await write.mutateAsync(review);
      choose(null);
      setNotice(
        receipt.reconciled
          ? 'Đã tìm thấy bản ghi của lần gửi trước. Kiểm tra lịch sử với mã ' + receipt.id + '.'
          : 'Đã ghi ' +
              (review.action === 'distribute'
                ? 'quyết định phân bổ'
                : review.action === 'source'
                  ? 'nguồn quỹ'
                  : 'mốc ứng lịch sử') +
              '. Mã đối chiếu ' +
              receipt.id +
              '. Thực chi 0 đồng.',
      );
    } catch (e) {
      const uncertain = e instanceof FinancialWorkflowError && e.outcome !== 'failure';
      setUnknown(uncertain);
      const code = e && typeof e === 'object' && 'code' in e ? e.code : null;
      if (code === 'PT409') {
        setReview(null);
        const message =
          e && typeof e === 'object' && 'message' in e && typeof e.message === 'string'
            ? e.message.replace(/^SHARED_FUND_[A-Z_]+:\s*/, '')
            : 'Số dư hoặc mốc đã thay đổi.';
        setIssue(message + ' Kiểm tra sổ và xem lại trước khi ghi.');
      } else
        setIssue(
          code === '42501'
            ? 'Bạn không có quyền ghi quỹ của tổ chức này.'
            : workflowErrorMessage(e, 'ghi sổ quỹ chung'),
        );
    }
  };
  return (
    <div className="grid gap-4">
      <Button type="button" variant="outline" aria-expanded={showHousePool} onClick={() => setShowHousePool(!showHousePool)}>
        Góp theo nhà và hoàn cho toàn bộ người góp
      </Button>
      {showHousePool && <HousePoolPanel org={org} shareholders={state.shareholders} enabled={enabled}/>}
      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="text-sm text-muted-foreground">Nguồn quỹ nhập theo chứng từ còn khả dụng</p>
        <p className="text-2xl font-semibold tabular-nums">{formatVND(state.available_amount)}</p>
        {state.last_effective_date && (
          <p className="text-xs text-muted-foreground">Ghi gần nhất ngày {date(state.last_effective_date)}</p>
        )}
      </div>
      {!enabled && <p role="status">Sổ đang ở chế độ chỉ xem.</p>}
      {!action && enabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => choose('source')}>
            {state.has_opening ? 'Ghi tăng / giảm nguồn' : 'Mở số dư quỹ'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!state.has_opening || state.available_amount <= 0 || !state.shareholders.length}
            onClick={() => choose('distribute')}
          >
            Phân bổ cho cổ đông
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              !state.shareholders.some(
                (p) => !state.openings.some((o) => o.shareholder_id === p.shareholder_id),
              )
            }
            onClick={() => choose('opening')}
          >
            Ghi mốc ứng lịch sử
          </Button>
        </div>
      )}
      {action && enabled && (
        <div hidden={!!review}>
          <SharedFundForm
            key={action}
            action={action}
            state={state}
            onReview={(op) => {
              setIssue('');
              setReview(op);
            }}
            onCancel={() => choose(null)}
          />
        </div>
      )}
      {review && enabled && (
        <section className="grid gap-2 rounded-md border p-4 text-sm" aria-label="Xác nhận ghi quỹ">
          <h3 className="font-semibold">Xác nhận ghi sổ</h3>
          <Review op={review} state={state} />
          <p className="break-words text-muted-foreground">Căn cứ: {review.evidence}</p>
          <p>Thực chi khi ghi nhận: 0 đồng. Khi trả tiền, lập phiếu qua luồng chi lợi nhuận.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={write.isPending} onClick={() => void confirm()}>
              {write.isPending ? 'Đang xử lý…' : unknown ? 'Kiểm tra lại yêu cầu' : 'Xác nhận ghi sổ'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={write.isPending || unknown}
              onClick={() => {
                setIssue('');
                setReview(null);
              }}
            >
              Sửa nội dung
            </Button>
          </div>
        </section>
      )}
      {issue && (
        <p role="alert" className="text-sm text-destructive">
          {issue}
        </p>
      )}
      {notice && (
        <p role="status" className="break-words rounded-md border p-3 text-sm">
          {notice}
        </p>
      )}
      <FundHistory state={state} onSettle={onSettle} />
    </div>
  );
}
