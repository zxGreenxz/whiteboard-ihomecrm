/** Local demonstration only. No Supabase imports or production writes. */
import { resolveSourceMessages, validateSourceRule, type DemoSource, type SourceMessage, type SourceRule } from './sourceRules';
export const MATCH_TOLERANCE = 10_000;
export const DEMO_ORG = 'DEMO';
export const money = (n: number) => `${new Intl.NumberFormat('vi-VN').format(n)}đ`;
export const normalize = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
export interface Cashbook { id: string; name: string; bank: string; account: string; buildings: string[] }
export interface Invoice {
  id: string; number: string; org: string; building: string; room: string; customers: string[]; period: string;
  books: string[]; total: number; paid: number; status: 'APPROVED' | 'PARTIAL_PAID' | 'OVERDUE' | 'PAID' | 'CANCELLED' | 'DRAFT';
  revision: number; kind: 'Tháng' | 'Thanh lý'; carriedBy?: string; debtNote?: string; debtUnclear?: boolean;
}
export interface Receipt { id: string; invoiceId: string; book: string; org: string; retained: number; applied: number; credit: number; reference: string; active: boolean; posted: boolean }
export interface Link { type: 'new' | 'existing'; invoiceId: string; receiptId: string; applied: number; credit: number; before?: Invoice; revisionAfter?: number }
export interface BankTransaction {
  id: string; org: string; at: string; receivedAt: string; amount: number; direction: 'in' | 'out'; book: string | null;
  reference: string; description: string; sources: string[]; balance?: number;
  issue?: string; classification?: 'other' | 'waiting'; note?: string; link?: Link;
  messages?: SourceMessage[]; routingIssue?: string; routingReasons?: string[];
}
export interface Audit { id: number; at: string; transactionId: string; action: string; detail: string; actor: string }
export interface DemoState { transactions: BankTransaction[]; invoices: Invoice[]; receipts: Receipt[]; audit: Audit[]; version: number; sourceRules: SourceRule[]; sourceHistory: { at: string; detail: string }[] }
export interface Candidate { invoice: Invoice; remaining: number; delta: number; reasons: string[]; evidence: number; competitors: number }
export interface MatchResult { candidates: Candidate[]; excluded: { invoice: Invoice; reason: string }[]; receipts: Receipt[]; blocked?: string }
export type Status = 'matched' | 'review' | 'existing' | 'suggested' | 'unmatched' | 'other' | 'waiting';
export const statusLabels: Record<Status, string> = { matched: 'Đã khớp', review: 'Cần kiểm tra', existing: 'Có thể đã ghi thu', suggested: 'Có gợi ý', unmatched: 'Chưa tìm được', other: 'Khoản khác', waiting: 'Chờ xử lý' };
export const outstanding = (i: Invoice) => Math.max(i.total - i.paid, 0);
const openStatuses: Invoice['status'][] = ['APPROVED', 'PARTIAL_PAID', 'OVERDUE'];
const includesToken = (text: string, token: string) => (` ${normalize(text).replace(/[^a-z0-9]/g, ' ')} `).includes(` ${normalize(token).replace(/[^a-z0-9]/g, ' ')} `);

function evaluate(t: BankTransaction, invoices: Invoice[]): Pick<MatchResult, 'candidates' | 'excluded'> {
  const candidates: Candidate[] = [], excluded: MatchResult['excluded'] = [];
  const namedInvoices = invoices.filter(i => includesToken(t.description, i.number));
  const namedBuildings = [...new Set(invoices.map(i => i.building))].filter(b => includesToken(t.description, b));
  const rooms = [...normalize(t.description).matchAll(/\b(?:phong|p)\s*([a-z]*\d+)\b/g)].map(m => m[1]);
  for (const i of invoices) {
    if (i.org !== t.org) continue;
    const remaining = outstanding(i), delta = t.amount - remaining;
    const reason = !t.book || !i.books.includes(t.book) ? 'Không nhận vào sổ ngân hàng này'
      : !openStatuses.includes(i.status) || remaining <= 0 ? 'Hóa đơn không còn ở trạng thái được thu'
      : i.carriedBy ? `Nợ đã nằm trong ${invoices.find(x => x.id === i.carriedBy)?.number ?? 'hóa đơn khác'}`
      : i.debtUnclear ? 'Cần kiểm tra nguồn nợ gộp'
      : Math.abs(delta) > MATCH_TOLERANCE ? `Lệch ${money(Math.abs(delta))}, vượt 10.000đ`
      : namedInvoices.length > 0 && !namedInvoices.some(x => x.id === i.id) ? 'Nội dung ghi mã hóa đơn khác'
      : namedBuildings.length > 0 && !namedBuildings.includes(i.building) ? 'Nội dung chỉ tòa khác'
      : rooms.length > 0 && !rooms.includes(normalize(i.room)) ? 'Nội dung chỉ phòng khác' : null;
    if (reason) { excluded.push({ invoice: i, reason }); continue; }
    const reasons = ['Đúng sổ nhận', delta === 0 ? 'Khớp số còn phải thu' : `Trong ngưỡng ±10.000đ`];
    if (namedInvoices.some(x => x.id === i.id)) reasons.push('Trùng mã hóa đơn');
    if (namedBuildings.includes(i.building)) reasons.push('Trùng tòa');
    if (rooms.includes(normalize(i.room))) reasons.push('Trùng phòng');
    if (i.customers.some(name => includesToken(t.description, name))) reasons.push('Trùng tên khách');
    candidates.push({ invoice: i, remaining, delta, reasons, evidence: reasons.length - 2, competitors: 0 });
  }
  candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || b.evidence - a.evidence || a.invoice.number.localeCompare(b.invoice.number));
  return { candidates, excluded };
}

export function findMatches(state: DemoState, t: BankTransaction): MatchResult {
  const empty = { candidates: [], excluded: [], receipts: [] };
  if (t.link) return { ...empty, blocked: 'Giao dịch đã được đối soát.' };
  if (t.direction !== 'in') return { ...empty, blocked: 'Tiền ra: phân loại, không thu hóa đơn khách thuê.' };
  if (t.issue) return { ...empty, blocked: t.issue };
  if (t.routingIssue) return { ...empty, blocked: t.routingIssue };
  if (!t.book) return { ...empty, blocked: 'Chưa xác định sổ nhận. Cần xác minh tài khoản trước.' };
  if (t.classification === 'other') return { ...empty, blocked: 'Đã phân loại khoản khác. Gỡ phân loại để tìm lại.' };
  if (!Number.isSafeInteger(t.amount) || t.amount <= 0) return { ...empty, blocked: 'Số tiền không hợp lệ.' };
  const receipts = state.receipts.filter(r => r.org === t.org && r.book === t.book && r.retained === t.amount && r.active && r.posted
    && !state.transactions.some(other => other.link?.receiptId === r.id));
  const result = evaluate(t, state.invoices);
  for (const c of result.candidates) {
    c.competitors = state.transactions.filter(other => other.id !== t.id && !other.link && !other.issue && !other.routingIssue && other.book && other.direction === 'in' && other.classification !== 'other'
      && evaluate(other, state.invoices).candidates.some(x => x.invoice.id === c.invoice.id)).length;
  }
  return { ...result, receipts };
}
export function transactionStatus(state: DemoState, t: BankTransaction): Status {
  if (t.link) return 'matched';
  if (t.classification) return t.classification;
  if (t.issue || t.routingIssue || !t.book) return 'review';
  if (t.direction === 'out') return 'other';
  const m = findMatches(state, t);
  return m.receipts.length ? 'existing' : m.candidates.length ? 'suggested' : 'unmatched';
}
export type Command =
  | { type: 'collect'; transactionId: string; invoiceId: string; expectedRevision: number }
  | { type: 'link'; transactionId: string; receiptId: string }
  | { type: 'classify'; transactionId: string; classification: 'other' | 'waiting'; reason: string }
  | { type: 'undo'; transactionId: string; reason: string };

/** Atomic in-memory transition for the demo; deliberately NOT the production V5 writer. */
export function applyDemoCommand(current: DemoState, command: Command, at: string): DemoState {
  const state = structuredClone(current);
  const t = state.transactions.find(x => x.id === command.transactionId);
  if (!t || t.org !== DEMO_ORG) throw new Error('Không tìm thấy giao dịch mẫu hợp lệ.');
  let action = '', detail = '';
  if (command.type === 'collect' || command.type === 'link') {
    const matches = findMatches(state, t);
    if (matches.blocked) throw new Error(matches.blocked);
    if (command.type === 'collect') {
      if (matches.receipts.length) throw new Error('Cần đối chiếu khoản thu đã có trước khi tạo khoản thu mới.');
      const c = matches.candidates.find(x => x.invoice.id === command.invoiceId);
      if (!c || c.invoice.revision !== command.expectedRevision) throw new Error('Hóa đơn hoặc gợi ý đã thay đổi. Vui lòng chọn lại.');
      const before = structuredClone(c.invoice), applied = Math.min(t.amount, c.remaining), credit = Math.max(c.delta, 0);
      c.invoice.paid += applied; c.invoice.revision++;
      c.invoice.status = outstanding(c.invoice) === 0 ? 'PAID' : 'PARTIAL_PAID';
      const receiptId = `DEMO-PT-${state.version + 1}-${t.id}`;
      state.receipts.push({ id: receiptId, invoiceId: c.invoice.id, org: t.org, book: t.book!, retained: t.amount, applied, credit, reference: t.reference, active: true, posted: true });
      t.link = { type: 'new', invoiceId: c.invoice.id, receiptId, applied, credit, before, revisionAfter: c.invoice.revision };
      action = 'Xác nhận thu mẫu'; detail = `${c.invoice.number} · áp dụng ${money(applied)} · credit ${money(credit)} · còn nợ ${money(outstanding(c.invoice))}`;
    } else {
      const r = matches.receipts.find(x => x.id === command.receiptId);
      if (!r) throw new Error('Khoản thu không còn hợp lệ hoặc đã được gắn giao dịch khác.');
      t.link = { type: 'existing', invoiceId: r.invoiceId, receiptId: r.id, applied: r.applied, credit: r.credit };
      action = 'Gắn khoản thu cũ'; detail = `${r.id} · không tạo thu mới · ${money(r.retained)}`;
    }
    delete t.classification;
  } else {
    const reason = command.reason.trim();
    if (!reason) throw new Error('Vui lòng nhập lý do.');
    if (command.type === 'classify') {
      if (t.link) throw new Error('Gỡ liên kết trước khi đổi phân loại.');
      t.classification = command.classification; t.note = reason;
      action = command.classification === 'other' ? 'Phân loại khoản khác' : 'Để chờ xử lý'; detail = reason;
    } else {
      if (!t.link && !t.classification) throw new Error('Giao dịch chưa có thao tác để hoàn tác.');
      if (t.link?.type === 'new') {
        const i = state.invoices.find(x => x.id === t.link?.invoiceId);
        if (!i || !t.link.before || i.revision !== t.link.revisionAfter) throw new Error('Hóa đơn đã có thay đổi tiếp theo; không thể hoàn tác nhanh.');
        Object.assign(i, t.link.before, { revision: i.revision + 1 });
        state.receipts = state.receipts.filter(r => r.id !== t.link?.receiptId);
      }
      delete t.link; delete t.classification; t.note = reason;
      action = 'Hoàn tác / gỡ liên kết'; detail = `${reason} · không hoàn tiền ngân hàng`;
    }
  }
  state.version++;
  state.audit.unshift({ id: state.version, at, transactionId: t.id, actor: 'Quản lý DEMO', action, detail });
  return routeDemoTransactions(state);
}

/** Re-evaluate pending items only. A confirmed receipt keeps its original book and evidence. */
export function routeDemoTransactions(state: DemoState): DemoState {
  return { ...state, transactions: state.transactions.map(t => {
    if (t.link || !t.messages) return t;
    const result = resolveSourceMessages(t.messages, state.sourceRules, t.org);
    return { ...t, book: result.bookId, routingReasons: result.reasons, routingIssue: result.status === 'resolved' ? undefined : result.reasons[0] };
  }) };
}
export function saveDemoSourceRules(current: DemoState, rules: SourceRule[], sources: DemoSource[], bookIds: string[], at: string): DemoState {
  if (new Set(rules.map(r => r.id)).size !== rules.length) throw new Error('Mã quy tắc bị trùng.');
  for (const rule of rules) {
    if (rule.org !== DEMO_ORG) throw new Error('Quy tắc ngoài công ty DEMO.');
    const errors = validateSourceRule(rule, sources, bookIds);
    if (errors.length) throw new Error(errors.join(' '));
  }
  const next = routeDemoTransactions({ ...current, sourceRules: structuredClone(rules) });
  const changed = next.transactions.filter((t, index) => t.book !== current.transactions[index]?.book || t.routingIssue !== current.transactions[index]?.routingIssue).length;
  return { ...next, sourceHistory: [{ at, detail: `Lưu ${rules.length} quy tắc · ${changed} giao dịch chưa khớp thay đổi sổ hoặc trạng thái. Giao dịch đã khớp giữ nguyên.` }, ...current.sourceHistory] };
}

export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
