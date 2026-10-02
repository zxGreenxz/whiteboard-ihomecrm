import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { registerRentSupportParty, quoteContractRentSupport, readRentSupportDepositCandidate, verifyRentSupportDepositPayee, type SupportRead, type VerifyDepositPayeeInput } from '@/lib/rentSupportApi';
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
import { LoadingState, RefreshBar } from '@/components/loading/LoadingState';
import { QlManagerSelectForBuilding } from '@/components/income-expenses/QlManagerSelect';
import AttachmentUpload from '@/components/income-expenses/AttachmentUpload';

interface SourceForm { partyId: string; managerId: string; amount: number; route: 'CASHBOOK' | 'MANAGER_PAYROLL'; accountId: string; payer: string; recipient: string; bank: string; accountNumber: string; attachments: string[] }
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
  DEPOSIT_ALREADY_PAID: 'Thưởng cọc đã trả; sức chứa khấu trừ bằng 0. Phần cam kết còn thiếu chỉ lấy từ hoa hồng hợp lệ theo chính sách.',
  AMBIGUOUS_DEPOSIT_CLAIM: 'Có nhiều yêu cầu thưởng cọc; đối chiếu đúng quyền lợi và chứng từ trước khi tiếp nhận.',
  DEPOSIT_LINKAGE_REVIEW: 'Liên kết hợp đồng, yêu cầu thưởng và phiếu cọc cần đối chiếu.',
  PAYMENT_EVIDENCE_REVIEW: 'Chưa xác minh được tiền thực trả của thưởng cọc; kiểm tra chứng từ thanh toán.',
  PARTIAL_PAYMENT_REVIEW: 'Thưởng cọc đã trả một phần; cần đối chiếu phần còn lại trước khi khấu trừ.',
  DEPOSIT_GROSS_REVIEW: 'Gross trên yêu cầu thưởng và dòng phiếu cọc chưa khớp; đối chiếu quyền lợi gốc.',
  DEPOSIT_NOT_MUTABLE: 'Phiếu thưởng cọc đã duyệt, ghi sổ hoặc thuộc kỳ khóa; cần xử lý chứng từ trước khi tiếp nhận.',
  SOURCE_ALREADY_ISSUED: 'Nguồn thưởng đã được xử lý; đối chiếu kết quả hiện có, không tạo nguồn thay thế.',
};

export function RentSupportPayoutForm({ organizationId, contractId, plan, prefill, rows, refetchRows, onlyKind, userId }: Props) {
  const financial = plan.financial;
  const contractVouchers = financial?.payload.sale_party_id === null;
  const { data: accounts = [] } = useAccounts();
  const payout = useRentSupportPayout(organizationId, contractId);
  const legacyRetry = useRetryCommissionVoucher();
  const intentIds = useRef({ broker: crypto.randomUUID(), sale: crypto.randomUUID() });
  const [date, setDate] = useState(prefill.signed_date);
  const [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
  const [adopt, setAdopt] = useState(false);
  const [adoptionReason, setAdoptionReason] = useState('');
  const [verificationParty, setVerificationParty] = useState('');
  const [verificationName, setVerificationName] = useState('');
  const pendingDepositRecipient = useRef<{ name: string; requestId: string; fingerprint: string; input: Omit<VerifyDepositPayeeInput, 'partyId'> } | null>(null);
  const [verificationReason, setVerificationReason] = useState('');
  const [verificationConfirmed, setVerificationConfirmed] = useState(false);
  const confirmedVerification = useRef<string | null>(null);
  const [verificationPending, setVerificationPending] = useState(false);
  const savedVerification = useRef<VerifyDepositPayeeInput | null>(null);
  const mounted = useRef(false);
  const active = useRef<symbol | null>(null);
  useEffect(() => {
    mounted.current = true; active.current = null; setPreflighting(false); setRetrying(false);
    savedVerification.current = null; setVerificationPending(false); setAdopt(false); setAdoptionReason('');
    setVerificationParty(''); setVerificationName(''); pendingDepositRecipient.current = null; setVerificationReason(''); setVerificationConfirmed(false); confirmedVerification.current = null;
    return () => { mounted.current = false; active.current = null; };
  }, [organizationId, contractId]);
  const initial = (amount: number): SourceForm => ({ partyId: '', managerId: '', amount, route: 'CASHBOOK', accountId: '', payer: '', recipient: '', bank: '', accountNumber: '', attachments: [] });
  const [forms, setForms] = useState({ broker: initial(prefill.matched_tier ? Math.round(prefill.rent_price * prefill.matched_tier.rate_percent / 100) : 0), sale: initial(0) });
  const update = (kind: CommissionKind, patch: Partial<SourceForm>) => setForms(current => ({ ...current, [kind]: {
    ...current[kind], ...patch,
    ...(contractVouchers && ('recipient' in patch || 'managerId' in patch || 'route' in patch) ? { partyId: '' } : {}),
  } }));
  const recipientRequests = useRef<Partial<Record<CommissionKind, { key: string; requestId: string }>>>({});
  const formsRef = useRef(forms); formsRef.current = forms;
  const [resolvingRecipients, setResolvingRecipients] = useState(false);
  const resolveRecipients = async () => {
    if (active.current || payout.pending || payout.receipt || resolvingRecipients) return;
    const token = Symbol('voucher recipients'); active.current = token;
    const current = () => mounted.current && active.current === token;
    const snapshot = forms;
    setResolvingRecipients(true); setError(null);
    try {
      for (const kind of selected) {
        if (kind === 'sale' && adopting) continue;
        const form = snapshot[kind];
        if (form.partyId) continue;
        if (!form.recipient.trim() || (form.route === 'MANAGER_PAYROLL' && !form.managerId))
          throw new Error(`Nhập người nhận ${labels[kind]} trên phiếu trước khi xem khoản thực nhận.`);
        const key = JSON.stringify([organizationId, contractId, prefill.building_id, form.route, form.managerId, form.recipient.trim()]);
        if (recipientRequests.current[kind]?.key !== key) recipientRequests.current[kind] = { key, requestId: crypto.randomUUID() };
        const request = recipientRequests.current[kind]!;
        const party = await registerRentSupportParty(organizationId, prefill.building_id!, {
          profileId: form.route === 'MANAGER_PAYROLL' ? form.managerId : null,
          displayName: form.recipient.trim(), reason: `Người nhận từ phiếu ${labels[kind]} của hợp đồng ${contractId}.`, requestId: request.requestId,
        });
        if (!current()) return;
        const live = formsRef.current[kind];
        if (live.recipient !== form.recipient || live.route !== form.route || live.managerId !== form.managerId)
          throw new Error('Thông tin người nhận đã đổi. Xem lại khoản thực nhận trước khi tạo phiếu.');
        setForms(value => ({ ...value, [kind]: { ...value[kind], partyId: party.party_id } }));
      }
    } catch (failure) { if (current()) setError(safeCommissionReason(failure instanceof Error ? failure.message : 'Chưa lưu được thông tin người nhận của phiếu. Bấm xem lại để thử đúng yêu cầu.')); }
    finally { if (current()) { active.current = null; setResolvingRecipients(false); } }
  };
  const done = (row: ContractCommissionFollowup) => ['VOUCHER_CREATED', 'SETTLED_BY_SUPPORT', 'NOT_APPLICABLE'].includes(row.state);
  const savedRows = rows.filter(row => row.request_id && (row.can_retry || row.state === 'PROCESSING') && !done(row));
  const deposit = useQuery({ queryKey: ['rent-support-deposit-candidate', organizationId, contractId, plan.revision],
    queryFn: () => readRentSupportDepositCandidate(organizationId, contractId), enabled: !!financial, retry: false, staleTime: 0 });
  const parties = useRentSupportParties(prefill.building_id, !contractVouchers || !!deposit.data?.verification);
  const candidate = deposit.data?.state === 'READY' ? deposit.data.candidate : null;
  const candidateCurrent = !!deposit.data && deposit.data.plan_revision === plan.revision && !deposit.isFetching && !deposit.isError;
  const verificationFingerprint = JSON.stringify([organizationId, contractId, plan.revision, deposit.data?.verification, verificationParty, verificationName, verificationReason]);
  const confirmationMatches = verificationConfirmed && confirmedVerification.current === verificationFingerprint;
  const saleAllowed = onlyKind !== 'broker' && rows.some(row => row.kind === 'sale' && row.can_manage) && !savedRows.some(row => row.kind === 'sale');
  const adopting = adopt && !!candidate && saleAllowed;
  const selected = (['broker', 'sale'] as const).filter(kind => onlyKind !== (kind === 'broker' ? 'sale' : 'broker')
    && rows.some(row => row.kind === kind && row.can_manage && (kind === 'sale' && adopting || !done(row))) && !savedRows.some(row => row.kind === kind)
    && (kind === 'sale' ? adopting || deposit.data?.state === 'NO_CANDIDATE' && forms.sale.amount > 0 : forms.broker.amount > 0));
  const parsed = payoutContextSchema.safeParse({ version: 3, intents: selected.map(kind => {
    if (kind === 'sale' && adopting && candidate) return { ...candidate.intent_template, intent_id: intentIds.current.sale, reason: adoptionReason.trim() };
    const form = forms[kind], party = parties.data?.find(party => party.party_id === form.partyId);
    return { action: 'ISSUE_NEW', intent_id: intentIds.current[kind], source_id: null, kind: kind === 'broker' ? 'COMMISSION' : 'BONUS', party_id: form.partyId,
      gross_amount: String(form.amount), route: form.route, manager_id: form.route === 'MANAGER_PAYROLL' ? (contractVouchers ? form.managerId || null : party?.profile_id ?? null) : null,
      account_id: form.route === 'MANAGER_PAYROLL' ? null : form.accountId || null, voucher_date: date, payer_name: form.payer || null,
      recipient_name: form.recipient || null, recipient_bank: form.bank || null, recipient_account: form.accountNumber || null,
      item_description: `${kind === 'broker' ? 'Hoa hồng' : 'Thưởng Sale'} HĐ ${prefill.contract_number ?? ''}`, attachments: form.attachments };
  }) });
  const context: PayoutContext | null = parsed.success ? parsed.data : null;
  const query = useQuery({ queryKey: ['support-payout-quote', organizationId, contractId, plan.revision, financial?.payload, context],
    enabled: !!context && !!financial && candidateCurrent && (contractVouchers || !parties.isFetching && !parties.isError) && !payout.pending && !verificationPending,
    queryFn: () => {
      if (!context || !financial) throw new Error('context');
      return quoteContractRentSupport(organizationId, { contractId, payload: financial.payload, payoutContext: context });
    }, retry: false, staleTime: 0 });
  const ready = !resolvingRecipients && !!context && !!financial && !financial.review && candidateCurrent && !verificationPending && !(adopt && !adopting) && (contractVouchers || !parties.isFetching && !parties.isError) && !query.isFetching && !query.isError && query.data?.state === 'READY'
    && query.data.plan_revision === plan.revision && selected.every(kind => query.data?.sources.some(source => source.intent_id === intentIds.current[kind]));
  const depositFingerprint = JSON.stringify(deposit.data);
  const fingerprint = JSON.stringify([organizationId, contractId, onlyKind, plan.revision, financial, context, deposit.data, query.data?.quote_hash, query.data?.payload_hash]);
  const latest = useRef({ fingerprint, ready, revision: plan.revision, depositFingerprint, verificationFingerprint }); latest.current = { fingerprint, ready, revision: plan.revision, depositFingerprint, verificationFingerprint };
  const run = async (action: 'submit' | 'retry' | 'read') => {
    if (active.current || payout.isPending || retrying || verificationPending) return;
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
        const freshDeposit = await deposit.refetch();
        if (!current()) return;
        if (freshDeposit.isError || JSON.stringify(freshDeposit.data) !== depositFingerprint || latest.current.fingerprint !== confirmedFingerprint)
          throw new Error('Nguồn thưởng cọc đã thay đổi hoặc chưa đọc được. Đối chiếu lại nguồn trước khi tạo phiếu.');
        if (fresh.isError || !fresh.data?.rows || selected.some(kind => !fresh.data?.rows?.some(row => row.kind === kind && row.can_manage && (kind === 'sale' && adopting || !done(row)) && !(row.request_id && (row.can_retry || row.state === 'PROCESSING')))))
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
    if (!row.request_id || retrying || active.current || payout.isPending || verificationPending) return;
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
  const verifyPayee = async () => {
    if (active.current || payout.isPending || retrying || payout.pending || payout.receipt) return;
    const facts = deposit.data?.verification;
    let input = savedVerification.current;
    if (!input && !pendingDepositRecipient.current) {
      if (!candidateCurrent || !facts || !deposit.data?.issues.some(issue => issue.code === 'PAYEE_UNVERIFIED') || !confirmationMatches
        || !verificationReason.trim() || verificationReason.trim().length > 2000
        || (contractVouchers ? !verificationName.trim() : !parties.data?.some(party => party.party_id === verificationParty) || parties.isError || parties.isFetching)) return;
      const base = { contractId, claimId: facts.claim_id, depositVoucherId: facts.deposit_voucher_id, bonusVoucherId: facts.bonus_voucher_id,
        expectedApprovalVersion: facts.approval_version, expectedPostingVersion: facts.posting_version, sourceFactsHash: facts.proof_hash, reason: verificationReason.trim(), requestId: crypto.randomUUID() };
      if (contractVouchers) pendingDepositRecipient.current = { name: verificationName.trim(), requestId: crypto.randomUUID(), fingerprint: verificationFingerprint, input: base };
      else { input = { ...base, partyId: verificationParty }; savedVerification.current = input; }
    }
    const revision = plan.revision, confirmedDeposit = depositFingerprint;
    const token = Symbol('verify deposit payee'); active.current = token;
    const current = () => mounted.current && active.current === token;
    setVerificationPending(true); setPreflighting(true); setError(null);
    try {
      const pending = pendingDepositRecipient.current;
      if (!input && pending) {
        const party = await registerRentSupportParty(organizationId, prefill.building_id!, {
          profileId: null, displayName: pending.name, reason: `Người nhận từ phiếu thưởng cọc ${pending.input.bonusVoucherId}. ${pending.input.reason}`.slice(0, 2000), requestId: pending.requestId,
        });
        if (!current()) return;
        if (latest.current.verificationFingerprint !== pending.fingerprint) {
          pendingDepositRecipient.current = null; setVerificationPending(false); setVerificationConfirmed(false);
          throw new Error('Thông tin phiếu thưởng cọc đã đổi; cần đối chiếu lại.');
        }
        input = { ...pending.input, partyId: party.party_id }; savedVerification.current = input; pendingDepositRecipient.current = null;
      }
      if (!input) throw new Error('Chưa có thông tin người nhận.');
      const saved = input;
      const binding = await verifyRentSupportDepositPayee(organizationId, saved);
      if (!current()) return;
      if (latest.current.revision !== revision || latest.current.depositFingerprint !== confirmedDeposit || binding.party_id !== saved.partyId)
        throw new Error('verification context changed');
      const observed = await deposit.refetch();
      if (!current()) return;
      if (observed.isError || latest.current.revision !== revision || observed.data?.plan_revision !== revision || !observed.data.candidate
        || observed.data.candidate.claim_id !== saved.claimId || observed.data.candidate.bonus_voucher_id !== saved.bonusVoucherId || observed.data.candidate.intent_template.party_id !== saved.partyId)
        throw new Error('verification needs review');
      savedVerification.current = null; setVerificationPending(false); setVerificationConfirmed(false);
    } catch { if (current()) setError('Chưa xác minh được kết quả xác nhận người hưởng. Thử lại đúng yêu cầu đã lưu; chưa gửi tạo phiếu hoặc khấu trừ.'); }
    finally { if (current()) { active.current = null; setPreflighting(false); } }
  };
  if (!financial || !plan.revision) return <p role="alert">Chưa đọc được thông tin tài chính của lịch hỗ trợ. Không thể tạo phiếu; hãy kiểm tra quyền và tải lại.</p>;
  const months = buildSupportMonths(financial.payload);
  return <div className="space-y-4 px-6 pb-6">
    <div className="rounded border bg-muted/30 p-3 text-sm space-y-1">
      <p>Người chịu hỗ trợ: <b>{financial.payload.payer === 'BUILDING' ? 'Tòa nhà' : contractVouchers ? 'Sale (khấu trừ vào phiếu của hợp đồng)' : `Sale — ${parties.data?.find(party => party.party_id === financial.payload.sale_party_id)?.display_name ?? 'danh tính đã lưu trong hợp đồng'}`}</b>.</p>
      <p>Chính sách đã lưu: <b>{financial.payload.deduction_policy === 'COMMISSION_ONLY' ? 'Chỉ khấu trừ hoa hồng' : 'Thưởng trước, phần thiếu sang hoa hồng'}</b>.</p>
      <p>Thu toàn bộ cam kết một lần: <b>{vnd(financial.committed_total)}</b> khi lập phiếu; khách vẫn được giảm theo từng tháng.</p>
      <details><summary>Lịch giảm tiền thuê của khách</summary><ul>{months.map(month => <li key={month.billing_month}>{month.invoice_period_label}: {vnd(month.agreed_amount)}</li>)}</ul></details>
    </div>
    {financial.review && <p role="alert">Lịch hỗ trợ đang cần đối chiếu điều chỉnh tài chính. Chưa thể lập phiếu ròng.</p>}
    {/* Chờ đọc thưởng cọc: khối xám khi chưa có, vạch mảnh mép trên hộp thoại khi đọc lại —
        không chữ (chủ chốt 02/10/2026). Các nút vẫn khoá theo điều kiện riêng như cũ. */}
    {deposit.isFetching && !deposit.data && <LoadingState label="thưởng cọc và bằng chứng người hưởng" rows={2} />}
    <RefreshBar active={deposit.isFetching && !!deposit.data} label="Đang đọc lại thưởng cọc và bằng chứng người hưởng" />
    {deposit.isError && <div role="alert"><p>Chưa đọc được thưởng cọc. Tải lại trước khi lập phiếu; không coi lỗi đọc là không có nguồn.</p><Button variant="outline" disabled={preflighting} onClick={() => void deposit.refetch()}>Đọc lại thưởng cọc</Button></div>}
    {deposit.data && deposit.data.plan_revision !== plan.revision && <p role="alert">Thưởng cọc chưa khớp phiên bản lịch hỗ trợ. Tải lại hợp đồng trước khi tiếp tục.</p>}
    {deposit.data?.issues.filter(issue => issue.code !== 'NO_CANDIDATE').map(issue => <p role="alert" key={issue.code}>{issues[issue.code] ?? 'Thưởng cọc cần đối chiếu chứng từ hoặc quyền lợi. Không tạo thưởng mới để thay thế nguồn chưa rõ; hoa hồng hợp lệ vẫn được đối chiếu riêng.'}</p>)}
    {saleAllowed && deposit.data?.verification && deposit.data.issues.some(issue => issue.code === 'PAYEE_UNVERIFIED') && <section className="rounded border p-3 space-y-2">
      <h3 className="font-medium">Xác nhận người hưởng thưởng cọc</h3>
      <p className="text-sm">Yêu cầu: {deposit.data.verification.claim_id}. Phiếu cọc: {deposit.data.verification.deposit_voucher_id}. Phiếu thưởng: {deposit.data.verification.bonus_voucher_id}. Gross: {vnd(deposit.data.verification.gross)}.</p>
      <fieldset disabled={preflighting || verificationPending || payout.isPending || !!payout.pending || !!payout.receipt} className="space-y-2">
        {contractVouchers ? <label className="block text-sm">Tên người nhận thưởng cọc<Input aria-label="Tên người nhận thưởng cọc" maxLength={200} value={verificationName} onChange={event => { setVerificationName(event.target.value); setVerificationConfirmed(false); }} /></label>
          : <label className="block text-sm">Người hưởng thưởng cọc<select aria-label="Người hưởng thưởng cọc" className="block w-full rounded border p-2" value={verificationParty} onChange={event => { setVerificationParty(event.target.value); setVerificationConfirmed(false); }}>
            <option value="">Chọn danh tính đã xác minh</option>{(parties.data ?? []).filter(party => party.party_id).map(party => <option key={party.party_id} value={party.party_id!}>{party.display_name}</option>)}
          </select></label>}
        <label className="block text-sm">Lý do xác nhận người hưởng<Input aria-label="Lý do xác nhận người hưởng" value={verificationReason} maxLength={2000} onChange={event => { setVerificationReason(event.target.value); setVerificationConfirmed(false); }} /></label>
        <label className="block text-sm"><input type="checkbox" aria-label="Đã đối chiếu đúng yêu cầu và phiếu cọc" checked={confirmationMatches} onChange={event => { confirmedVerification.current = event.target.checked ? verificationFingerprint : null; setVerificationConfirmed(event.target.checked); }} /> Đã đối chiếu đúng yêu cầu và phiếu cọc ở trên với danh tính được chọn.</label>
      </fieldset>
      <p className="text-sm">Xác nhận chỉ lưu danh tính người hưởng; chưa tạo phiếu, chưa khấu trừ hỗ trợ.</p>
      {!verificationPending && <Button disabled={!candidateCurrent || !confirmationMatches || !verificationReason.trim() || (contractVouchers ? !verificationName.trim() : !verificationParty || parties.isFetching || parties.isError) || preflighting || payout.isPending || !!payout.pending || !!payout.receipt} onClick={() => void verifyPayee()}>Xác nhận người hưởng thưởng cọc</Button>}
    </section>}
    {verificationPending && <div role="status" className="rounded border p-3 text-sm"><p>Yêu cầu xác nhận đã lưu; chưa xác minh kết quả. Giữ nguyên danh tính và chứng từ đã chọn.</p><Button disabled={preflighting || payout.isPending} onClick={() => void verifyPayee()}>Thử lại xác nhận đã lưu</Button></div>}
    {saleAllowed && candidate && <fieldset disabled={preflighting || verificationPending || payout.isPending || !!payout.pending || !!payout.receipt} className="rounded border p-3 space-y-2">
      <p className="text-sm">Thưởng cọc hiện có: {vnd(candidate.gross)}; đã trả: {vnd(candidate.already_paid)}; khoản ròng hiện tại: {vnd(candidate.current_net)}. Sử dụng đúng phiếu thưởng {candidate.bonus_voucher_id}; không tạo thưởng trùng.</p>
      <p className="text-sm">Người hưởng đã xác minh: {parties.data?.find(party => party.party_id === candidate.intent_template.party_id)?.display_name ?? 'danh tính đã xác minh trên nguồn'}.</p>
      <label className="block text-sm"><input type="checkbox" aria-label="Sử dụng thưởng cọc hiện có" checked={adopt} onChange={event => setAdopt(event.target.checked)} /> Sử dụng thưởng cọc hiện có theo chính sách đã lưu.</label>
      {adopt && <label className="block text-sm">Lý do tiếp nhận thưởng cọc<Input aria-label="Lý do tiếp nhận thưởng cọc" value={adoptionReason} minLength={8} maxLength={1000} onChange={event => setAdoptionReason(event.target.value)} /><span>Nhập lý do đối chiếu từ 8 đến 1000 ký tự.</span></label>}
    </fieldset>}
    {savedRows.map(row => <div key={row.kind} className="rounded border p-3 text-sm space-y-2">
      <p>Yêu cầu {labels[row.kind]} đã lưu. Tạo lại sử dụng đúng nội dung trước đó.</p>
      {row.last_reason && <p>{safeCommissionReason(row.last_reason)}</p>}
      {row.can_retry && ['FAILED', 'UNKNOWN'].includes(row.state) ? <Button disabled={preflighting || verificationPending || retrying || payout.isPending} onClick={() => void retrySaved(row)}>Tạo lại {labels[row.kind]}</Button>
        : <Button onClick={() => void refetchRows()}>Đối chiếu lại yêu cầu</Button>}
    </div>)}
    <fieldset disabled={resolvingRecipients || preflighting || verificationPending || retrying || payout.isPending || !!payout.pending || !!payout.receipt} className="space-y-4">
      <label className="block text-sm">Ngày phiếu<DateInput value={date} onChange={setDate} /></label>
      {(['broker', 'sale'] as const).filter(kind => onlyKind !== (kind === 'broker' ? 'sale' : 'broker') && (kind !== 'sale' || candidateCurrent && deposit.data?.state === 'NO_CANDIDATE') && rows.some(row => row.kind === kind && row.can_manage && !done(row)) && !savedRows.some(row => row.kind === kind)).map(kind => {
        const form = forms[kind];
        return <section key={kind} className="rounded border p-3 space-y-2">
          <h3 className="font-medium">{kind === 'broker' ? 'Hoa hồng môi giới' : 'Thưởng Sale (chỉ chọn khi cần tạo)'}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm">Gross {labels[kind]}<CurrencyInput aria-label={`Gross ${labels[kind]}`} value={form.amount} onChange={amount => update(kind, { amount: amount || 0 })} /></label>
            {!contractVouchers && <label className="text-sm">Người hưởng {labels[kind]}<select aria-label={`Người hưởng ${labels[kind]}`} className="block w-full rounded border p-2" value={form.partyId} onChange={event => update(kind, { partyId: event.target.value })}>
              <option value="">Chọn danh tính đã xác minh</option>{(parties.data ?? []).filter(party => party.party_id).map(party => <option key={party.party_id} value={party.party_id!}>{party.display_name}</option>)}
            </select></label>}
            <label className="text-sm">Luồng chi {labels[kind]}<select aria-label={`Luồng chi ${labels[kind]}`} className="block w-full rounded border p-2" value={form.route} onChange={event => update(kind, { route: event.target.value === 'MANAGER_PAYROLL' ? 'MANAGER_PAYROLL' : 'CASHBOOK' })}>
              <option value="CASHBOOK">Sổ quỹ</option>{kind === 'broker' && <option value="MANAGER_PAYROLL">Hoa hồng quản lý trả qua lương</option>}
            </select></label>
            {form.route === 'CASHBOOK' ? <label className="text-sm">Sổ quỹ {labels[kind]}<select className="block w-full rounded border p-2" value={form.accountId} onChange={event => update(kind, { accountId: event.target.value })}>
              <option value="">Chọn sổ khi duyệt phiếu</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select></label> : contractVouchers ? <QlManagerSelectForBuilding id={`support-manager-${kind}`} buildingId={prefill.building_id} value={form.managerId}
              onPick={manager => update(kind, { managerId: manager.staffId, recipient: manager.displayName })} />
              : <p className="text-sm">Khoản ròng chuyển sang sổ ảo chờ trả lương; duyệt không đồng nghĩa đã trả.</p>}
            {(['payer', 'recipient', 'bank', 'accountNumber'] as const).filter(field => !(contractVouchers && form.route === 'MANAGER_PAYROLL' && field === 'recipient')).map(field => <label key={field} className="text-sm">{{ payer: 'Tên đơn vị / Sale', recipient: 'Tên người nhận', bank: 'Ngân hàng', accountNumber: 'Số tài khoản' }[field]}<Input aria-label={`${field} ${kind}`} value={form[field]} onChange={event => update(kind, { [field]: event.target.value })} /></label>)}
          </div>
          {userId && <AttachmentUpload userId={userId} attachments={form.attachments} onChange={attachments => update(kind, { attachments })} />}
        </section>;
      })}
    </fieldset>
    {contractVouchers && !payout.pending && !payout.receipt && <Button variant="outline" disabled={!selected.length || resolvingRecipients || preflighting || payout.isPending} onClick={() => void resolveRecipients()}>
      {resolvingRecipients ? 'Đang đọc thông tin phiếu…' : 'Xem khấu trừ và thực nhận'}
    </Button>}
    {parties.isError && <p role="alert">Chưa tải được danh tính trong tòa; hãy tải lại trước khi chọn người hưởng.</p>}
    {!context && <p className="text-sm">Nhập số tiền và thông tin người nhận trên phiếu để xem khoản khấu trừ và thực nhận.</p>}
    {query.isFetching && !query.data && <LoadingState label="nguồn và khoản khấu trừ" variant="table" rows={2} />}
    <RefreshBar active={query.isFetching && !!query.data} label="Đang đối chiếu lại nguồn và khoản khấu trừ" />
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
