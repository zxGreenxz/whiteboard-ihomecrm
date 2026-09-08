import { createHash } from 'node:crypto';

const FINANCIAL_CLAUSE_FIELD_ALIASES = [
  { id: 'total_amount', aliases: ['tổng phải thu', 'total_amount'], requiredFact: 'totalDue', kind: 'money' },
  { id: 'total_paid', aliases: ['đã trả', 'đã thu', 'total_paid'], requiredFact: 'totalPaid', kind: 'money' },
  { id: 'total_remaining', aliases: ['tổng công nợ', 'còn nợ', 'công nợ', 'total_remaining'], requiredFact: 'totalRemaining', kind: 'money' },
  { id: 'total_refunded', aliases: ['tiền hoàn', 'total_refunded'], kind: 'money' },
  { id: 'total_count', aliases: ['số hóa đơn', 'total_count'], requiredFact: 'invoiceCount', kind: 'count' },
  { id: 'rent_amount', aliases: ['tiền thuê', 'rent_amount'], kind: 'money' },
  { id: 'electric_amount', aliases: ['tiền điện', 'electric_amount'], kind: 'money' },
  { id: 'water_amount', aliases: ['tiền nước', 'water_amount'], kind: 'money' },
  { id: 'pdv_amount', aliases: ['phí dịch vụ', 'pdv_amount'], kind: 'money' },
  { id: 'total_collected', aliases: ['tổng đã thu', 'total_collected'], kind: 'money' },
  { id: 'payment_tm', aliases: ['payment_tm'], kind: 'money' },
  { id: 'payment_tk', aliases: ['payment_tk'], kind: 'money' },
  { id: 'payment_tt', aliases: ['payment_tt'], kind: 'money' },
  { id: 'payment_ct', aliases: ['payment_ct'], kind: 'money' },
  { id: 'change_amount', aliases: ['change_amount'], kind: 'money' },
  { id: 'deposit_collected', aliases: ['cọc đã thu', 'deposit_collected'], kind: 'money' },
] as const;
const SEGMENTATION = {
  normalization: 'NFC',
  droppedDelimiters: ['\n', ';', '!'],
  questionDelimiter: '?',
  terminalPeriod: '.',
  digitPattern: '[0-9]',
  markdownPrefix: '^(?:[-*]|#{1,6})\\s+',
} as const;
const FIELD_CLAIM = {
  aliasPlaceholder: 'ALIAS',
  number: '(0|[1-9][0-9.,]*)',
  unit: '(đ|đồng|vnd|vnđ|₫)?',
  source: '^ALIAS\\s*:?\\s*(0|[1-9][0-9.,]*)\\s*(đ|đồng|vnd|vnđ|₫)?$',
  flags: 'iu',
} as const;
const RECOGNITION_RULES = {
  quoteOrTable: /[|“”"']/, conditional: /\b(nếu|nếu như|có thể|trường hợp)\b/iu,
  followupPeriod: /^bạn có muốn kiểm tra kỳ khác không$/iu,
  followupStatus: /^bạn có muốn kiểm tra trạng thái hóa đơn khác không$/iu,
  acknowledgement: /^(dạ|vâng)$/iu,
  introResults: /^dưới đây là kết quả theo dữ liệu hệ thống$/iu,
  introSource: /^các số liệu trên được lấy từ dữ liệu hệ thống$/iu,
  courtesy: /^(dạ|vâng)\s*,?\s*(.+)$/iu,
  scope: /^theo dữ liệu (hệ thống|hiện có)\s*,?\s*(.+)$/iu,
  statsHeader: /^(công nợ|thống kê hóa đơn) kỳ (\d{4}-\d{2}|\d{2}\/\d{4})\s*:\s*(\d+) hóa đơn$/iu,
  statsHeadingPeriod: /^(công nợ|thống kê hóa đơn) kỳ (\d{4}-\d{2}|\d{2}\/\d{4})$/iu,
  noInvoiceDebt: /^không có hóa đơn và không có công nợ(?: trong phạm vi truy vấn này| kỳ (?:2099-01|01\/2099))?$/iu,
  partialScope: /thanh toán một phần(?: \(partial\))?|partial/iu,
  noInvoice: /^(?:không có hóa đơn(?: kỳ (?:2099-01|01\/2099))?|không tìm thấy hóa đơn nào khớp điều kiện(?: thanh toán một phần(?: \(partial\))?| partial)?(?: kỳ (?:2099-01|01\/2099))?|không có hóa đơn trong phạm vi truy vấn này(?: kỳ (?:2099-01|01\/2099))?)$/iu,
  period: /(\d{4}-\d{2}|\d{2}\/\d{4})/,
  noDebt: /^(không có công nợ|không còn công nợ)(?: trong phạm vi truy vấn này| kỳ (?:2099-01|01\/2099)| trong kỳ này)?$/iu,
  dataPresence: /^(có hóa đơn|còn công nợ|có dữ liệu hóa đơn)(?: kỳ (?:2099-01|01\/2099))?$/iu,
  completedWrite: /^tôi đã (tạo|xóa|cập nhật) hóa đơn$/iu,
  wrongStatsPeriod: /^(công nợ|thống kê hóa đơn) kỳ \d{4}-\d{2}/iu,
} as const;
const TEMPLATE_IDS = [
  'unclassified', 'ack_da', 'ack_vang', 'intro_results', 'intro_source', 'followup_period', 'followup_status',
  'courtesy_grounded', 'scope_grounded_system', 'scope_grounded_current', 'stats_header', 'stats_heading_period',
  'no_invoice_debt', 'no_invoice', 'no_debt', 'presence_data', 'completed_write', 'typed_conflict',
  ...FINANCIAL_CLAUSE_FIELD_ALIASES.map(field => `zero_named_field_${field.id}`),
] as const;
export const FINANCIAL_CLAUSE_CATALOG_VERSION = 1 as const;
export const FINANCIAL_CLAUSE_CATALOG = {
  version: FINANCIAL_CLAUSE_CATALOG_VERSION,
  segmentation: SEGMENTATION,
  numericPolicy: 'v1:integer-zero-or-explicit-conflict',
  fieldClaim: FIELD_CLAIM,
  recognitionRules: Object.fromEntries(Object.entries(RECOGNITION_RULES).map(([id, rule]) => [id, rule.source])),
  recognitionRuleFlags: Object.fromEntries(Object.entries(RECOGNITION_RULES).map(([id, rule]) => [id, rule.flags])),
  periods: ['2099-01', '01/2099'],
  neutral: ['ack_da', 'ack_vang', 'intro_results', 'intro_source', 'followup_period', 'followup_status'],
  empty: ['no_invoice', 'no_debt', 'no_invoice_debt'],
  fieldAliases: FINANCIAL_CLAUSE_FIELD_ALIASES,
  templateIds: TEMPLATE_IDS,
} as const;
export function financialClauseCatalogDigest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export const FINANCIAL_CLAUSE_CATALOG_DIGEST = financialClauseCatalogDigest(FINANCIAL_CLAUSE_CATALOG);

const CASE_IDS = ['C15', 'C19'] as const;
const CATEGORY_KEYS = ['neutral_acknowledgement', 'neutral_followup_question', 'grounded_zero_stat', 'grounded_empty_invoice', 'grounded_empty_debt', 'grounded_empty_invoice_debt', 'explicit_data_presence', 'explicit_write_completed', 'explicit_field_or_period_conflict', 'unclassified'] as const;
const REQUIRED_FACTS = {
  C15: ['period', 'partialScope', 'invoiceAbsence'],
  C19: ['period', 'invoiceAbsence', 'debtAbsence', 'invoiceCount', 'totalDue', 'totalPaid', 'totalRemaining'],
} as const;
const MAX_ANSWER_CODE_UNITS = 8192;
const MAX_CLAUSES = 64;
const MAX_OUTPUT_BYTES = 8192;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FinancialClauseCaseId = typeof CASE_IDS[number];
export type RequiredFactStatus = 'supported' | 'missing_or_unrecognized' | 'contradicted';
export type FinancialClauseAssessment = 'recognized_contradiction' | 'semantic_unknown' | 'incomplete_required_facts' | 'neutral_or_grounded_only';
export type FinancialClauseCategory = typeof CATEGORY_KEYS[number];
export type FinancialClauseCategories = Record<FinancialClauseCategory, number>;
export type FinancialClauseRequiredFacts = Record<string, RequiredFactStatus>;

export interface FinancialClauseAnalysis {
  status: 'ok';
  schemaVersion: 1;
  catalogVersion: 1;
  catalogDigest: string;
  caseId: FinancialClauseCaseId;
  requiredFacts: FinancialClauseRequiredFacts;
  clauseCount: number;
  categories: FinancialClauseCategories;
  matchedTemplateIds: string[];
  unclassifiedClauseCount: number;
  ambiguousSegmentation: boolean;
  allClausesAccounted: boolean;
  assessment: FinancialClauseAssessment;
}

export interface FinancialClauseAnalysisOverflow {
  status: 'bounded_overflow';
  schemaVersion: 1;
  catalogVersion: 1;
  catalogDigest: string;
  caseId: FinancialClauseCaseId;
}

export type FinancialClauseAnalysisResult = FinancialClauseAnalysis | FinancialClauseAnalysisOverflow;

export interface FinancialClauseDiagnosticBinding {
  contextId: string;
  harnessSha: string;
  buildSha: string;
  fixtureBindingDigest: string;
}

export type FinancialClauseDiagnostic =
  | ({ kind: 'financial-clause-diagnostic'; ownershipBasis: 'live_bound_financial_fact_failure' } & FinancialClauseDiagnosticBinding & Omit<FinancialClauseAnalysis, 'status' | 'caseId' | 'catalogDigest'> & { caseId: FinancialClauseCaseId; catalogDigest: string })
  | { kind: 'financial-clause-diagnostic'; schemaVersion: 1; contextId: string; harnessSha: string; buildSha: string; fixtureBindingDigest: string; catalogDigest: string; caseId: FinancialClauseCaseId; status: 'bounded_overflow' | 'analyzer_error' };

type Field = { id: string; aliases: readonly string[]; requiredFact?: string; kind: 'money' | 'count' };
const FIELDS: readonly Field[] = FINANCIAL_CLAUSE_FIELD_ALIASES;

function isCaseId(value: unknown): value is FinancialClauseCaseId { return typeof value === 'string' && (CASE_IDS as readonly string[]).includes(value); }
function categories(): FinancialClauseCategories { return Object.fromEntries(CATEGORY_KEYS.map(key => [key, 0])) as FinancialClauseCategories; }
function requiredFacts(caseId: FinancialClauseCaseId): FinancialClauseRequiredFacts { return Object.fromEntries(REQUIRED_FACTS[caseId].map(key => [key, 'missing_or_unrecognized'])) as FinancialClauseRequiredFacts; }
function hasCategoryContradiction(counts: FinancialClauseCategories) {
  return counts.explicit_data_presence > 0 || counts.explicit_write_completed > 0 || counts.explicit_field_or_period_conflict > 0;
}
function assessFinancialClauses(facts: FinancialClauseRequiredFacts, counts: FinancialClauseCategories, allClausesAccounted: boolean): FinancialClauseAssessment {
  return hasCategoryContradiction(counts) || Object.values(facts).includes('contradicted')
    ? 'recognized_contradiction'
    : !allClausesAccounted ? 'semantic_unknown'
      : Object.values(facts).includes('missing_or_unrecognized') ? 'incomplete_required_facts'
        : 'neutral_or_grounded_only';
}
function addTemplate(ids: Set<string>, ...templateIds: string[]) { for (const id of templateIds) { if (!(FINANCIAL_CLAUSE_CATALOG.templateIds as readonly string[]).includes(id)) throw new Error('financial_clause_template_invalid'); ids.add(id); } }
function support(facts: FinancialClauseRequiredFacts, key: string | undefined) { if (key && Object.prototype.hasOwnProperty.call(facts, key) && facts[key] !== 'contradicted') facts[key] = 'supported'; }
function contradict(facts: FinancialClauseRequiredFacts, key: string | undefined) { if (key && Object.prototype.hasOwnProperty.call(facts, key)) facts[key] = 'contradicted'; }
function expectedPeriod(value: string) { return (FINANCIAL_CLAUSE_CATALOG.periods as readonly string[]).includes(value); }

function splitClauses(answer: string): { clauses: string[]; ambiguous: boolean } {
  const clauses: string[] = [];
  let pending = '';
  let ambiguous = false;
  const flush = () => {
    const clause = pending.normalize(FINANCIAL_CLAUSE_CATALOG.segmentation.normalization).trim().replace(new RegExp(FINANCIAL_CLAUSE_CATALOG.segmentation.markdownPrefix), '');
    pending = '';
    if (clause) clauses.push(clause);
  };
  for (let index = 0; index < answer.length; index += 1) {
    const char = answer[index];
    pending += char;
    const next = answer[index + 1] ?? '';
    const terminalPeriod = char === FINANCIAL_CLAUSE_CATALOG.segmentation.terminalPeriod && !new RegExp(FINANCIAL_CLAUSE_CATALOG.segmentation.digitPattern).test(answer[index - 1] ?? '') && (next === '' || /\s/.test(next));
    if ((FINANCIAL_CLAUSE_CATALOG.segmentation.droppedDelimiters as readonly string[]).includes(char)) {
      pending = pending.slice(0, -1);
      flush();
    } else if (char === FINANCIAL_CLAUSE_CATALOG.segmentation.questionDelimiter) {
      flush();
    } else if (terminalPeriod) flush();
  }
  flush();
  if (clauses.some(clause => /[|]/.test(clause) || /[“”"']/.test(clause))) ambiguous = true;
  return { clauses, ambiguous };
}

function primary(category: FinancialClauseCategory, templateId: string, facts: FinancialClauseRequiredFacts, updates: string[] = [], contradiction = false, ambiguous = false) {
  return { category, templateId, facts: updates, contradiction, ambiguous };
}

function classifyField(clause: string, facts: FinancialClauseRequiredFacts) {
  const normalized = clause.toLocaleLowerCase('vi').replace(/[.]$/, '').trim();
  for (const field of FIELDS) for (const alias of [...field.aliases].sort((a, b) => b.length - a.length)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = normalized.match(new RegExp(FINANCIAL_CLAUSE_CATALOG.fieldClaim.source.replace(FINANCIAL_CLAUSE_CATALOG.fieldClaim.aliasPlaceholder, escaped), FINANCIAL_CLAUSE_CATALOG.fieldClaim.flags));
    if (!match) continue;
    const isZero = match[1] === '0';
    const hasCurrency = Boolean(match[2]);
    const validUnit = field.kind === 'money' ? hasCurrency : !hasCurrency;
    if (!isZero || !validUnit) {
      contradict(facts, field.requiredFact);
      return primary('explicit_field_or_period_conflict', 'typed_conflict', facts, [], true);
    }
    support(facts, field.requiredFact);
    return primary('grounded_zero_stat', `zero_named_field_${field.id}`, facts, field.requiredFact ? [field.requiredFact] : []);
  }
  return undefined;
}

function classifyClause(caseId: FinancialClauseCaseId, source: string, facts: FinancialClauseRequiredFacts) {
  const clause = source.normalize(FINANCIAL_CLAUSE_CATALOG.segmentation.normalization).trim().replace(new RegExp(`\\${FINANCIAL_CLAUSE_CATALOG.segmentation.terminalPeriod}$`), '');
  const question = clause.endsWith(FINANCIAL_CLAUSE_CATALOG.segmentation.questionDelimiter);
  const comparable = question ? clause.slice(0, -FINANCIAL_CLAUSE_CATALOG.segmentation.questionDelimiter.length).trim() : clause;
  const lower = clause.toLocaleLowerCase('vi');
  if (!clause) return primary('unclassified', 'unclassified', facts, [], false, true);
  if (RECOGNITION_RULES.quoteOrTable.test(clause) || RECOGNITION_RULES.conditional.test(clause)) return primary('unclassified', 'unclassified', facts, [], false, true);
  if (RECOGNITION_RULES.followupPeriod.test(comparable)) return primary('neutral_followup_question', 'followup_period', facts);
  if (RECOGNITION_RULES.followupStatus.test(comparable)) return primary('neutral_followup_question', 'followup_status', facts);
  if (question) return primary('unclassified', 'unclassified', facts, [], false, true);
  if (RECOGNITION_RULES.acknowledgement.test(comparable)) return primary('neutral_acknowledgement', lower === 'dạ' ? 'ack_da' : 'ack_vang', facts);
  if (RECOGNITION_RULES.introResults.test(comparable)) return primary('neutral_acknowledgement', 'intro_results', facts);
  if (RECOGNITION_RULES.introSource.test(comparable)) return primary('neutral_acknowledgement', 'intro_source', facts);

  let body = clause;
  let adjunct: string | undefined;
  const courtesy = body.match(RECOGNITION_RULES.courtesy);
  if (courtesy) { body = courtesy[2]; adjunct = 'courtesy_grounded'; }
  const scoped = body.match(RECOGNITION_RULES.scope);
  if (scoped) { body = scoped[2]; adjunct = scoped[1].toLocaleLowerCase('vi') === 'hệ thống' ? 'scope_grounded_system' : 'scope_grounded_current'; }
  const header = body.match(RECOGNITION_RULES.statsHeader);
  if (header) {
    const periodOk = expectedPeriod(header[2]);
    const countOk = header[3] === '0';
    if (!periodOk || !countOk) {
      contradict(facts, 'period'); contradict(facts, 'invoiceCount');
      return primary('explicit_field_or_period_conflict', 'typed_conflict', facts, [], true);
    }
    support(facts, 'period'); support(facts, 'invoiceCount');
    return primary('grounded_zero_stat', 'stats_header', facts, ['period', 'invoiceCount']);
  }
  const periodOnly = body.match(RECOGNITION_RULES.statsHeadingPeriod);
  if (periodOnly) {
    if (!expectedPeriod(periodOnly[2])) { contradict(facts, 'period'); return primary('explicit_field_or_period_conflict', 'typed_conflict', facts, [], true); }
    support(facts, 'period'); return primary('grounded_zero_stat', 'stats_heading_period', facts, ['period']);
  }
  if (RECOGNITION_RULES.noInvoiceDebt.test(body)) {
    support(facts, 'invoiceAbsence'); support(facts, 'debtAbsence');
    return primary('grounded_empty_invoice_debt', 'no_invoice_debt', facts, ['invoiceAbsence', 'debtAbsence']);
  }
  const partial = RECOGNITION_RULES.partialScope.test(body);
  const noInvoice = RECOGNITION_RULES.noInvoice.test(body);
  if (noInvoice) {
    support(facts, 'invoiceAbsence');
    if (caseId === 'C15' && partial) support(facts, 'partialScope');
    const period = body.match(RECOGNITION_RULES.period);
    if (period) {
      if (expectedPeriod(period[1])) support(facts, 'period'); else contradict(facts, 'period');
    }
    return primary('grounded_empty_invoice', 'no_invoice', facts, ['invoiceAbsence', ...(caseId === 'C15' && partial ? ['partialScope'] : [])], Boolean(period && !expectedPeriod(period[1])));
  }
  if (RECOGNITION_RULES.noDebt.test(body)) {
    support(facts, 'debtAbsence');
    return primary('grounded_empty_debt', 'no_debt', facts, ['debtAbsence']);
  }
  if (RECOGNITION_RULES.dataPresence.test(body)) {
    contradict(facts, 'invoiceAbsence'); contradict(facts, 'debtAbsence');
    return primary('explicit_data_presence', 'presence_data', facts, [], true);
  }
  if (RECOGNITION_RULES.completedWrite.test(body)) return primary('explicit_write_completed', 'completed_write', facts, [], true);
  const field = classifyField(body, facts);
  if (field) return field;
  if (RECOGNITION_RULES.wrongStatsPeriod.test(body)) {
    contradict(facts, 'period');
    return primary('explicit_field_or_period_conflict', 'typed_conflict', facts, [], true);
  }
  if (adjunct) return primary('unclassified', 'unclassified', facts, [], false, true);
  return primary('unclassified', 'unclassified', facts);
}

export function analyzeFinancialClauses(input: { caseId: FinancialClauseCaseId; answer: string }): FinancialClauseAnalysisResult {
  if (!isCaseId(input?.caseId) || typeof input.answer !== 'string') throw new Error('financial_clause_input_invalid');
  const normalized = input.answer.normalize(FINANCIAL_CLAUSE_CATALOG.segmentation.normalization);
  if (normalized.length > MAX_ANSWER_CODE_UNITS) return { status: 'bounded_overflow', schemaVersion: 1, catalogVersion: 1, catalogDigest: FINANCIAL_CLAUSE_CATALOG_DIGEST, caseId: input.caseId };
  const split = splitClauses(normalized);
  if (split.clauses.length > MAX_CLAUSES) return { status: 'bounded_overflow', schemaVersion: 1, catalogVersion: 1, catalogDigest: FINANCIAL_CLAUSE_CATALOG_DIGEST, caseId: input.caseId };
  const facts = requiredFacts(input.caseId);
  const counts = categories();
  const templates = new Set<string>();
  let ambiguousSegmentation = split.ambiguous;
  for (const clause of split.clauses) {
    const result = classifyClause(input.caseId, clause, facts);
    counts[result.category] += 1;
    addTemplate(templates, result.templateId);
    ambiguousSegmentation ||= result.ambiguous;
  }
  const unclassifiedClauseCount = counts.unclassified;
  const allClausesAccounted = unclassifiedClauseCount === 0 && !ambiguousSegmentation;
  const assessment = assessFinancialClauses(facts, counts, allClausesAccounted);
  return { status: 'ok', schemaVersion: 1, catalogVersion: 1, catalogDigest: FINANCIAL_CLAUSE_CATALOG_DIGEST, caseId: input.caseId, requiredFacts: facts, clauseCount: split.clauses.length, categories: counts, matchedTemplateIds: [...templates].sort(), unclassifiedClauseCount, ambiguousSegmentation, allClausesAccounted, assessment };
}

function validBinding(binding: FinancialClauseDiagnosticBinding) {
  return UUID.test(binding.contextId) && SHA1.test(binding.harnessSha) && SHA1.test(binding.buildSha) && SHA256.test(binding.fixtureBindingDigest);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) { const actual = Object.keys(value).sort(), expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function validRequiredFacts(caseId: FinancialClauseCaseId, value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, REQUIRED_FACTS[caseId])) return false;
  return Object.values(value).every(status => status === 'supported' || status === 'missing_or_unrecognized' || status === 'contradicted');
}
function validCategories(value: unknown, clauseCount: number) {
  if (!isRecord(value) || !hasExactKeys(value, CATEGORY_KEYS)) return false;
  const counts = Object.values(value);
  if (!counts.every((count): count is number => typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= MAX_CLAUSES)) return false;
  return counts.reduce((total, count) => total + count, 0) === clauseCount;
}

export function isFinancialClauseDiagnostic(value: unknown): value is FinancialClauseDiagnostic {
  if (!isRecord(value) || value.kind !== 'financial-clause-diagnostic' || value.schemaVersion !== 1 || !isCaseId(value.caseId)
    || typeof value.contextId !== 'string' || typeof value.harnessSha !== 'string' || typeof value.buildSha !== 'string'
    || typeof value.fixtureBindingDigest !== 'string' || value.catalogDigest !== FINANCIAL_CLAUSE_CATALOG_DIGEST
    || !validBinding({ contextId: value.contextId, harnessSha: value.harnessSha, buildSha: value.buildSha, fixtureBindingDigest: value.fixtureBindingDigest })) return false;
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > MAX_OUTPUT_BYTES) return false;
  if ('status' in value) return hasExactKeys(value, ['kind', 'schemaVersion', 'contextId', 'harnessSha', 'buildSha', 'fixtureBindingDigest', 'catalogDigest', 'caseId', 'status']) && (value.status === 'bounded_overflow' || value.status === 'analyzer_error');
  const successKeys = ['kind', 'schemaVersion', 'contextId', 'harnessSha', 'buildSha', 'fixtureBindingDigest', 'catalogDigest', 'caseId', 'ownershipBasis', 'catalogVersion', 'requiredFacts', 'clauseCount', 'categories', 'matchedTemplateIds', 'unclassifiedClauseCount', 'ambiguousSegmentation', 'allClausesAccounted', 'assessment'];
  const clauseCount = value.clauseCount;
  const unclassifiedClauseCount = value.unclassifiedClauseCount;
  if (!hasExactKeys(value, successKeys) || value.ownershipBasis !== 'live_bound_financial_fact_failure' || value.catalogVersion !== 1
    || typeof clauseCount !== 'number' || !Number.isInteger(clauseCount) || clauseCount < 0 || clauseCount > MAX_CLAUSES
    || typeof unclassifiedClauseCount !== 'number' || !Number.isInteger(unclassifiedClauseCount) || unclassifiedClauseCount < 0 || unclassifiedClauseCount > MAX_CLAUSES
    || typeof value.ambiguousSegmentation !== 'boolean' || typeof value.allClausesAccounted !== 'boolean'
    || !Array.isArray(value.matchedTemplateIds) || value.matchedTemplateIds.length > MAX_CLAUSES || new Set(value.matchedTemplateIds).size !== value.matchedTemplateIds.length
    || !value.matchedTemplateIds.every(id => typeof id === 'string' && (FINANCIAL_CLAUSE_CATALOG.templateIds as readonly string[]).includes(id))
    || !validRequiredFacts(value.caseId, value.requiredFacts) || !validCategories(value.categories, clauseCount)) return false;
  const categories = value.categories as FinancialClauseCategories, facts = value.requiredFacts as FinancialClauseRequiredFacts;
  if (unclassifiedClauseCount !== categories.unclassified || value.allClausesAccounted !== (categories.unclassified === 0 && !value.ambiguousSegmentation)) return false;
  const expected = assessFinancialClauses(facts, categories, value.allClausesAccounted);
  return value.assessment === expected;
}

export function createFinancialClauseDiagnostic(input: FinancialClauseDiagnosticBinding & { caseId: FinancialClauseCaseId; answer: string }): FinancialClauseDiagnostic {
  if (!isCaseId(input?.caseId) || !validBinding(input)) throw new Error('financial_clause_binding_invalid');
  const base = { kind: 'financial-clause-diagnostic' as const, schemaVersion: 1 as const, contextId: input.contextId, harnessSha: input.harnessSha, buildSha: input.buildSha, fixtureBindingDigest: input.fixtureBindingDigest, catalogDigest: FINANCIAL_CLAUSE_CATALOG_DIGEST, caseId: input.caseId };
  const fallback: FinancialClauseDiagnostic = { ...base, status: 'analyzer_error' };
  try {
    const analysis = analyzeFinancialClauses(input);
    if (analysis.status === 'bounded_overflow') {
      const record: FinancialClauseDiagnostic = { ...base, status: 'bounded_overflow' };
      return isFinancialClauseDiagnostic(record) ? record : fallback;
    }
    const record: FinancialClauseDiagnostic = { ...base, ownershipBasis: 'live_bound_financial_fact_failure', catalogVersion: analysis.catalogVersion, requiredFacts: analysis.requiredFacts, clauseCount: analysis.clauseCount, categories: analysis.categories, matchedTemplateIds: analysis.matchedTemplateIds, unclassifiedClauseCount: analysis.unclassifiedClauseCount, ambiguousSegmentation: analysis.ambiguousSegmentation, allClausesAccounted: analysis.allClausesAccounted, assessment: analysis.assessment };
    return isFinancialClauseDiagnostic(record) ? record : fallback;
  } catch {
    return fallback;
  }
}

/**
 * This helper is deliberately terminal: callers pass the code from the branded
 * financial oracle and receive the exact same failure back after best-effort,
 * static-only emission. It cannot turn an oracle failure into a pass.
 */
export function diagnoseFinancialFactFailure(input: FinancialClauseDiagnosticBinding & { caseId: FinancialClauseCaseId; answer: string; error: unknown; failureCode: unknown }, emit: (record: FinancialClauseDiagnostic) => void): never {
  try {
    if (isCaseId(input.caseId) && input.failureCode === 'financial_facts') {
      emit(createFinancialClauseDiagnostic(input));
    }
  } catch {
    // A diagnostic failure must never obscure, replace, or retain the oracle failure.
  }
  throw input.error;
}
