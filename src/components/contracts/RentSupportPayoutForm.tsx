import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { quoteContractRentSupport, type SupportRead } from '@/lib/rentSupportApi';
import { payoutContextSchema, type PayoutContext } from '@/lib/rentSupportFunding';
import { buildSupportMonths } from '@/lib/rentSupport';
import { safeCommissionReason, type CommissionKind, type ContractCommissionFollowup } from '@/lib/contractCommissionFollowup';
import { useRentSupportPayout } from '@/hooks/useRentSupportPayout';
import { useRentSupportParties } from '@/hooks/useRentSupportParties';
import { useAccounts } from '@/hooks/useAccounts';
import { useRetryCommissionVoucher, type CommissionPrefillData } from '@/hooks/useCommissionVoucher';
import { Input } from '@/components/ui/input';
import { CurrencyInput } from '@/components/ui/currency-input';
import { DateInput } from '@/components/ui/date-input';
import { Button } from '@/components/ui/button';
import AttachmentUpload from '@/components/income-expenses/AttachmentUpload';

interface SourceForm { partyId: string; amount: number; route: 'CASHBOOK' | 'MANAGER_PAYROLL'; accountId: string; payer: string; recipient: string; bank: string; accountNumber: string; attachments: string[] }
interface Props { organizationId: string; contractId: string; plan: SupportRead['rows'][number]; prefill: CommissionPrefillData;
  rows: ContractCommissionFollowup[]; refetchRows: () => Promise<{ data?: { rows?: ContractCommissionFollowup[] }; isError: boolean }>;
  onlyKind?: CommissionKind; userId?: string }
const labels = { broker: 'hoa hồng', sale: 'thưởng' } as const;
const vnd = (money: string | number) => new Intl.NumberFormat('vi-VN').format(Number(money)) + ' đ';
const issues: Record<string, string> = {
  INSUFFICIENT_CAPACITY: 'Nguồn được chọn chưa đủ cam kết. Đối chiếu quyền lợi hoặc chọn đúng nguồn theo chính sách đã lưu.',
  PAYEE_MISMATCH: 'Người hưởng nguồn chi khác người chịu hỗ trợ. Kiểm tra danh tính đã xác minh trước khi tiếp tục.',
  PARTY_UNVERIFIED: 'Cần xác minh danh tính người chịu hoặc người hưởng trong danh mục.',
  LEGACY_REVIEW: 'Nguồn cũ cần đối chiếu gross, khoản đã giữ và thực trả bằng chứng từ trước khi lập phiếu.',
  PAYEE_UNVERIFIED: 'Thưởng cọc chưa xác minh người hưởng. Xác nhận danh tính với bằng chứng trước khi sử dụng nguồn.',
};

export function RentSupportPayoutForm({ organizationId, contractId, plan, prefill, rows, refetchRows, onlyKind, userId }: Props) {
  const financial = plan.financial;
  const parties = useRentSupportParties(prefill.building_id, true);
  const { data: accounts = [] } = useAccounts();
  const payout = useRentSupportPayout(organizationId, contractId);
  const legacyRetry = useRetryCommissionVoucher();
  const intentIds = useRef({ broker: crypto.randomUUID(), sale: crypto.randomUUID() });
  const [date, setDate] = useState(prefill.signed_date);
  const [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const mounted = useRef(false);
  const active = useRef<symbol | null>(null);
  useEffect(() => {
    mounted.current = true; active.current = null; setPreflighting(false); setRetrying(false);
    return () => { mounted.current = false; active.current = null; };
  }, [organizationId, contractId]);
  const initial = (amount: number): SourceForm => ({ partyId: '', amount, route: 'CASHBOOK', accountId: '', payer: '', recipient: '', bank: '', accountNumber: '', attachments: [] });
  const [forms, setForms] = useState({ broker: initial(prefill.matched_tier ? Math.round(prefill.rent_price * prefill.matched_tier.rate_percent / 100) : 0), sale: initial(0) });
  const update = (kind: CommissionKind, patch: Partial<SourceForm>) => setForms(current => ({ ...current, [kind]: { ...current[kind], ...patch } }));
  const done = (row: ContractCommissionFollowup) => ['VOUCHER_CREATED', 'SETTLED_BY_SUPPORT', 'NOT_APPLICABLE'].includes(row.state);
  const savedRows = rows.filter(row => row.request_id && (row.can_retry || row.state === 'PROCESSING') && !done(row));
  const selected = (['broker', 'sale'] as const).filter(kind => onlyKind !== (kind === 'broker' ? 'sale' : 'broker')
    && rows.some(row => row.kind === kind && row.can_manage && !done(row)) && !savedRows.some(row => row.kind === kind) && forms[kind].amount > 0);
  const parsed = payoutContextSchema.safeParse({ version: 2, intents: selected.map(kind => {
    const form = forms[kind], party = parties.data?.find(party => party.party_id === form.partyId);
    return { intent_id: intentIds.current[kind], source_id: null, kind: kind === 'broker' ? 'COMMISSION' : 'BONUS', party_id: form.partyId,
      gross_amount: String(form.amount), route: form.route, manager_id: form.route === 'MANAGER_PAYROLL' ? party?.profile_id ?? null : null,
      account_id: form.route === 'MANAGER_PAYROLL' ? null : form.accountId || null, voucher_date: date, payer_name: form.payer || null,
      recipient_name: form.recipient || null, recipient_bank: form.bank || null, recipient_account: form.accountNumber || null,
      item_description: `${kind === 'broker' ? 'Hoa hồng' : 'Thưởng Sale'} HĐ ${prefill.contract_number ?? ''}`, attachments: form.attachments };
  }) });
  const context: PayoutContext | null = parsed.success ? parsed.data : null;
  const query = useQuery({ queryKey: ['support-payout-quote', organizationId, contractId, plan.revision, financial?.payload, context],
    enabled: !!context && !!financial && !parties.isFetching && !parties.isError && !payout.pending,
    queryFn: () => {
      if (!context || !financial) throw new Error('context');
      return quoteContractRentSupport(organizationId, { contractId, payload: financial.payload, payoutContext: context });
    }, retry: false, staleTime: 0 });
  const ready = !!context && !!financial && !financial.review && !parties.isFetching && !parties.isError && !query.isFetching && !query.isError && query.data?.state === 'READY'
    && query.data.plan_revision === plan.revision && selected.every(kind => query.data?.sources.some(source => source.intent_id === intentIds.current[kind]));
  const fingerprint = JSON.stringify([organizationId, contractId, onlyKind, plan.revision, financial, context, query.data?.quote_hash, query.data?.payload_hash]);
  const latest = useRef({ fingerprint, ready }); latest.current = { fingerprint, ready };
  const run = async (action: 'submit' | 'retry' | 'read') => {
    if (active.current || payout.isPending || retrying) return;
    const submission = Symbol('payout preflight'); active.current = submission;
    const current = () => mounted.current && active.current === submission;
    const confirmedFingerprint = fingerprint;
    setPreflighting(true);
    setError(null);
    try {
      if (action === 'submit') {
        if (!ready || !context || !query.data || !plan.revision) return;
        const fresh = await refetchRows();
        if (!current()) return;
        if (latest.current.fingerprint !== confirmedFingerprint || !latest.current.ready)
          throw new Error('Nội dung hoặc lịch hỗ trợ đã thay đổi trong lúc đối chiếu. Kiểm tra lại khoản thực nhận rồi tạo phiếu.');
        if (fresh.isError || !fresh.data?.rows || selected.some(kind => !fresh.data?.rows?.some(row => row.kind === kind && row.can_manage && !done(row) && !(row.request_id && (row.can_retry || row.state === 'PROCESSING')))))
          throw new Error('Trạng thái tạo phiếu đã thay đổi. Đối chiếu yêu cầu đã lưu trước khi tiếp tục.');
        const result = await payout.submit({ contractId, planRevision: plan.revision, quoteHash: query.data.quote_hash, payload: context });
        if (!current()) return;
        setRecovered(result.recovered);
      } else {
        const result = action === 'retry' ? await payout.retry() : await payout.reconcile();
        if (current()) setRecovered(result.recovered);
      }
    } catch (failure) { if (current()) setError(safeCommissionReason(failure instanceof Error ? failure.message : 'Chưa xác minh được kết quả tạo phiếu.')); }
    finally { if (current()) { active.current = null; setPreflighting(false); } }
  };
  const retrySaved = async (row: ContractCommissionFollowup) => {
    if (!row.request_id || retrying || active.current || payout.isPending) return;
    const submission = Symbol('saved request preflight'); active.current = submission;
    const current = () => mounted.current && active.current === submission;
    setRetrying(true); setError(null);
    try {
      const fresh = await refetchRows(), live = fresh.data?.rows?.find(item => item.kind === row.kind);
      if (!current()) return;
      if (fresh.isError || !live?.can_manage || !live.can_retry || live.request_id !== row.request_id || !['FAILED', 'UNKNOWN'].includes(live.state)) throw new Error('Yêu cầu đã thay đổi; hãy đối chiếu lại.');
      await legacyRetry.mutateAsync({ contract_id: contractId, kind: row.kind, request_id: row.request_id });
      if (!current()) return;
      await refetchRows();
    } catch { if (current()) setError('Chưa xác minh được kết quả Tạo lại. Yêu cầu vẫn được theo dõi trên hợp đồng.'); }
    finally { if (current()) { active.current = null; setRetrying(false); } }
  };
  if (!financial || !plan.revision) return <p role="alert">Chưa đọc được thông tin tài chính của lịch hỗ trợ. Không thể tạo phiếu; hãy kiểm tra quyền và tải lại.</p>;
  const months = buildSupportMonths(financial.payload);
  return <div className="space-y-4 px-6 pb-6">
    <div className="rounded border bg-muted/30 p-3 text-sm space-y-1">
      <p>Người chịu hỗ trợ: <b>{financial.payload.payer === 'BUILDING' ? 'Tòa nhà' : `Sale — ${parties.data?.find(party => party.party_id === financial.payload.sale_party_id)?.display_name ?? 'danh tính đã lưu trong hợp đồng'}`}</b>.</p>
      <p>Chính sách đã lưu: <b>{financial.payload.deduction_policy === 'COMMISSION_ONLY' ? 'Chỉ khấu trừ hoa hồng' : 'Thưởng trước, phần thiếu sang hoa hồng'}</b>.</p>
      <p>Thu toàn bộ cam kết một lần: <b>{vnd(financial.committed_total)}</b> khi lập phiếu; khách vẫn được giảm theo từng tháng.</p>
      <details><summary>Lịch giảm tiền thuê của khách</summary><ul>{months.map(month => <li key={month.billing_month}>{month.invoice_period_label}: {vnd(month.agreed_amount)}</li>)}</ul></details>
    </div>
    {financial.review && <p role="alert">Lịch hỗ trợ đang cần đối chiếu điều chỉnh tài chính. Chưa thể lập phiếu ròng.</p>}
    {savedRows.map(row => <div key={row.kind} className="rounded border p-3 text-sm space-y-2">
      <p>Yêu cầu {labels[row.kind]} đã lưu. Tạo lại sử dụng đúng nội dung trước đó.</p>
      {row.last_reason && <p>{safeCommissionReason(row.last_reason)}</p>}
      {row.can_retry && ['FAILED', 'UNKNOWN'].includes(row.state) ? <Button disabled={preflighting || retrying || payout.isPending} onClick={() => void retrySaved(row)}>Tạo lại {labels[row.kind]}</Button>
        : <Button onClick={() => void refetchRows()}>Đối chiếu lại yêu cầu</Button>}
    </div>)}
    <fieldset disabled={preflighting || retrying || payout.isPending || !!payout.pending || !!payout.receipt} className="space-y-4">
      <label className="block text-sm">Ngày phiếu<DateInput value={date} onChange={setDate} /></label>
      {(['broker', 'sale'] as const).filter(kind => onlyKind !== (kind === 'broker' ? 'sale' : 'broker') && rows.some(row => row.kind === kind && row.can_manage && !done(row)) && !savedRows.some(row => row.kind === kind)).map(kind => {
        const form = forms[kind];
        return <section key={kind} className="rounded border p-3 space-y-2">
          <h3 className="font-medium">{kind === 'broker' ? 'Hoa hồng môi giới' : 'Thưởng Sale (chỉ chọn khi cần tạo)'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm">Gross {labels[kind]}<CurrencyInput aria-label={`Gross ${labels[kind]}`} value={form.amount} onChange={amount => update(kind, { amount: amount || 0 })} /></label>
            <label className="text-sm">Người hưởng {labels[kind]}<select aria-label={`Người hưởng ${labels[kind]}`} className="block w-full rounded border p-2" value={form.partyId} onChange={event => update(kind, { partyId: event.target.value })}>
              <option value="">Chọn danh tính đã xác minh</option>{(parties.data ?? []).filter(party => party.party_id).map(party => <option key={party.party_id} value={party.party_id!}>{party.display_name}</option>)}
            </select></label>
            <label className="text-sm">Luồng chi {labels[kind]}<select aria-label={`Luồng chi ${labels[kind]}`} className="block w-full rounded border p-2" value={form.route} onChange={event => update(kind, { route: event.target.value === 'MANAGER_PAYROLL' ? 'MANAGER_PAYROLL' : 'CASHBOOK' })}>
              <option value="CASHBOOK">Sổ quỹ</option>{kind === 'broker' && <option value="MANAGER_PAYROLL">Hoa hồng quản lý trả qua lương</option>}
            </select></label>
            {form.route === 'CASHBOOK' ? <label className="text-sm">Sổ quỹ {labels[kind]}<select className="block w-full rounded border p-2" value={form.accountId} onChange={event => update(kind, { accountId: event.target.value })}>
              <option value="">Chọn sổ khi duyệt phiếu</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select></label> : <p className="text-sm">Chọn danh tính quản lý nội bộ đã xác minh. Khoản ròng chuyển sang sổ ảo chờ trả lương; duyệt không đồng nghĩa đã trả.</p>}
            {(['payer', 'recipient', 'bank', 'accountNumber'] as const).map(field => <label key={field} className="text-sm">{{ payer: 'Tên đơn vị / Sale', recipient: 'Tên người nhận', bank: 'Ngân hàng', accountNumber: 'Số tài khoản' }[field]}<Input aria-label={`${field} ${kind}`} value={form[field]} onChange={event => update(kind, { [field]: event.target.value })} /></label>)}
          </div>
          {userId && <AttachmentUpload userId={userId} attachments={form.attachments} onChange={attachments => update(kind, { attachments })} />}
        </section>;
      })}
    </fieldset>
    {parties.isError && <p role="alert">Chưa tải được danh tính trong tòa; hãy tải lại trước khi chọn người hưởng.</p>}
    {!context && <p className="text-sm">Chọn số tiền, danh tính đã xác minh và luồng chi phù hợp để đối chiếu khoản thực nhận.</p>}
    {query.isFetching && <p role="status">Đang đối chiếu nguồn và khoản khấu trừ…</p>}
    {query.isError && <div role="alert"><p>Chưa đối chiếu được nguồn chi. Tải lại trước khi tạo; chưa ghi nhận yêu cầu tạo phiếu.</p><Button variant="outline" onClick={() => void query.refetch()}>Đối chiếu lại nguồn chi</Button></div>}
    {query.data?.state !== 'READY' && query.data?.issues.map(issue => <p role="alert" key={issue.code}>{issues[issue.code] ?? 'Nguồn chi cần đối chiếu trước khi tạo phiếu. Kiểm tra quyền lợi, tiền đã trả và danh tính theo chứng từ.'}</p>)}
    {query.data && <div className="overflow-auto"><table className="w-full text-sm"><thead><tr><th>Nguồn</th><th>Theo thỏa thuận</th><th>Đã trả hoặc giữ trước</th><th>Khấu trừ lần này</th><th>Thực nhận lần này</th></tr></thead>
      <tbody>{query.data.sources.map(source => <tr key={source.source_id}><td>{source.kind === 'COMMISSION' ? 'Hoa hồng' : 'Thưởng'}{source.route === 'MANAGER_PAYROLL' ? ' qua lương' : ''}</td><td>{vnd(source.gross_original)}</td><td>Đã trả: {vnd(source.already_paid)}<br />Đã giữ: {vnd(source.prior_withheld)}</td><td>{vnd(source.current_withheld)}</td><td>{vnd(source.net_this_operation)}</td></tr>)}</tbody></table></div>}
    {(error || payout.error) && <p role="alert" className="text-destructive">{error || payout.error}</p>}
    {payout.pending && <div className="rounded border p-3 text-sm space-y-2"><p>Yêu cầu đã lưu; chưa hoàn tất. Không gửi nội dung form mới.</p>
      <Button variant="outline" disabled={preflighting || payout.isPending} onClick={() => void run('read')}>Đối chiếu kết quả đã lưu</Button>{' '}
      <Button disabled={preflighting || payout.isPending} onClick={() => void run('retry')}>Tạo lại yêu cầu đã lưu</Button>
    </div>}
    {payout.receipt?.status === 'COMPLETED' && <div role="status" className="rounded border border-emerald-300 p-3 text-sm">
      {recovered && <p>Đã tìm thấy kết quả yêu cầu trước. Nội dung đang nhập chưa được gửi thêm.</p>}
      {payout.receipt.sources.map(source => <p key={source.source_id}>{source.status === 'SETTLED_BY_SUPPORT' ? 'Đã xử lý bằng hỗ trợ tiền thuê; không tạo phiếu chi 0.' : `Đã có phiếu ${source.code ?? ''}; duyệt không đồng nghĩa đã thanh toán.`} Theo thỏa thuận: {vnd(source.gross)}; khấu trừ: {vnd(source.withheld)}; thực nhận: {vnd(source.net)}.</p>)}
    </div>}
    {!payout.pending && !payout.receipt && <Button disabled={!ready || preflighting || payout.isPending || retrying} onClick={() => void run('submit')}>Tạo phiếu ròng</Button>}
  </div>;
}
