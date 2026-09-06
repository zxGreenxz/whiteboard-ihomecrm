#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRun, validateBrowserRun } from './copilot-golden-browser-evidence.mjs';

const LANES = new Set(['mock', 'real-model']);

export function validateRunProvenance(provenance) {
  const problems = [];
  if (!LANES.has(provenance?.lane)) problems.push('lane must be mock or real-model');
  if (!/^[0-9a-f]{40}$/i.test(String(provenance?.buildSha ?? ''))) problems.push('buildSha is required');
  if (!String(provenance?.providerModel ?? '').trim()) problems.push('providerModel is required');
  return problems;
}

function percentile(values, p) {
  if (!values.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * values.length));
  return values[Math.min(rank, values.length) - 1];
}

export function aggregateGoldenResults(results) {
  const counts = { pass: 0, partial: 0, fail: 0, blocked: 0 };
  const latencies = [];
  for (const result of results ?? []) {
    if (Object.hasOwn(counts, result?.status)) counts[result.status] += 1;
    else counts.blocked += 1;
    if (Number.isFinite(result?.latencyMs) && result.latencyMs >= 0) latencies.push(Number(result.latencyMs));
  }
  latencies.sort((a, b) => a - b);
  return {
    total: (results ?? []).length,
    counts,
    latencyMs: {
      min: latencies.length ? latencies[0] : null,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? latencies[latencies.length - 1] : null,
    },
  };
}

function normalizePrompt(input) {
  return String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Match intent-specific phrases after accent folding; avoid broad fragments such
// as "no" that make unrelated finance prompts look like multiple tools.
const TOOL_MARKERS = [
  ['phong_trong', /\bphong\b.*\btrong\b/],
  ['tim_khach_hang', /\btim khach\b(?! hen\b)/],
  ['tim_hoa_don', /\bhoa don\b|\bcon no (?:thang|ky)\b/],
  ['hop_dong_sap_het_han', /\bhop dong\b.*\b(?:sap het han|het han)\b/],
  ['doanh_thu_thang', /\b(?:doanh thu|kqkd)\b/],
  ['ty_le_lap_day', /\blap day\b/],
  ['cong_no_tong_quan', /\bcong no\b/],
  ['coc_dang_giu', /\b(?:tien coc|coc dang giu)\b/],
  ['so_quy', /\bso quy\b/],
  ['liet_ke_chu_de', /\bco tai lieu nghiep vu nao\b/],
  ['huong_dan', /\bhuong dan\b|\btai lieu\b.*\bchu de\b/],
  ['ban_do_he_thong', /\bban do\b|\btao hop dong o dau\b/],
  // G1-C1. Each marker is deliberately narrower than the tool's own vocabulary so
  // it cannot swallow a prompt that belongs to an older tool: "hop dong" alone
  // already belongs to hop_dong_sap_het_han, and "chi" alone appears inside
  // "chi tiet".
  ['tim_hop_dong', /\btim hop dong\b/],
  ['chi_tiet_hop_dong', /\bchi tiet hop dong\b/],
  ['tim_phieu_thu_chi', /\bphieu thu chi\b|\bphieu (?:thu|chi)\b/],
  ['hop_cho_duyet', /\bhop cho duyet\b|\bcho (?:toi )?duyet\b/],
  // G1-C2. Same discipline as the G1-C1 block above: each marker is narrower
  // than the tool's own vocabulary, so it cannot swallow a prompt that belongs
  // to an older tool. "cong to" is not "cong ty" after accent folding, and
  // "cong viec" is not "cong no".
  //
  // Adding these forced ONE correction above. `tim_khach_hang` matched the bare
  // fragment "tim khach", so "tim khach hen" — a LEAD search — matched BOTH it
  // and the new lead marker, and inferMockOutcome() then read the prompt as two
  // intents. The fix is the narrowest one that is still true: exclude exactly the
  // lead phrase, `(?! hen\b)`.
  //
  // The obvious "tidier" fix — requiring the full "tim khach hang" — was written
  // first and REVERTED: C14 ("Tim khach bang so dien thoai...") and C27 ("Tim
  // khach Nguyen An va phong trong...") both say "tim khach" without "hang", so
  // that version silently stopped routing two pinned cases. Narrowing a marker so
  // it answers for fewer prompts is not weakening the router — but narrowing it
  // past the prompts it is supposed to answer is, and only the pinned corpus test
  // in scripts/__tests__/run-copilot-golden-eval.test.mjs said which was which.
  ['tim_khach_hen', /\bkhach hen\b/],
  ['chi_so_cong_to', /\bcong to\b/],
  ['tim_xe', /\bbien so\b|\btim xe\b/],
  ['cong_viec', /\bcong viec\b/],
  ['ton_kho_vat_tu', /\bvat tu\b|\bton kho\b/],
  // G1-C3, the ten report tools. Same discipline again, and here it was the hard
  // part: five of these reports talk about the SAME nouns as an older tool.
  //
  //   phong_trong already owns the "phong ... trong" shape, so the vacant-room
  //   REPORT — the one that answers "how long has it been empty" — is routed by
  //   "ngay trong" instead. Widening the older marker to share the noun would have
  //   made every "phong trong" prompt match two tools, and inferMockOutcome() reads
  //   two tools as multi-intent: the corpus test would call that a routing failure,
  //   correctly.
  //   tim_hoa_don owns "hoa don", so the overpayment report is routed by
  //   "tra thua"/"thu thua" and its prompt never says "hoa don".
  //   so_quy owns "so quy" and tim_phieu_thu_chi owns "phieu thu"/"phieu chi", so
  //   the daily cashbook is routed by the whole phrase "thu chi theo ngay".
  //   coc_dang_giu owns "tien coc"/"coc dang giu" (deposit held ON A CONTRACT); the
  //   booking-deposit report is a different business object and is routed by
  //   "dat coc".
  //   huong_dan owns "huong dan", and C10 is literally "Huong dan thanh ly hop
  //   dong" — so the termination REPORT needs the qualifier too: "ca thanh ly" or
  //   "bao cao thanh ly", never the bare verb.
  ['bao_cao_phong_trong', /\bngay trong\b/],
  ['bao_cao_gia_han', /\bgia han\b/],
  ['bao_cao_thanh_ly', /\b(?:ca|bao cao) thanh ly\b/],
  ['bao_cao_hop_dong_moi', /\bhop dong moi\b/],
  // 'Ti le' va 'ty le' deu la cach viet thuong gap; bo dau xong chung khac nhau
  // mot chu cai, nen marker phai nhan ca hai.
  ['bao_cao_ty_le_chi_phi', /\bt[iy] le chi phi\b/],
  ['bao_cao_thu_chi_theo_ngay', /\bthu chi theo ngay\b/],
  ['bao_cao_dong_tien', /\bdong tien\b/],
  ['bao_cao_lich_thu_tien', /\blich thu tien\b/],
  ['bao_cao_thu_thua', /\bthu thua\b|\btra thua\b/],
  ['bao_cao_dat_coc', /\bdat coc\b/],
  // G1-C4, bon mien nhay cam. Cung ky luat nhu hai khoi tren — va o day co mot
  // cai bay rieng cua tieng Viet bo dau: 'so luong' cung fold ve 'luong', nen
  // marker luong phai di kem 'bang' hoac 'thang', khong duoc dung mot minh.
  // 'mang' (mang luoi) cung la 'mang' (mang vac) sau khi bo dau, nen trang thai
  // mang duoc dinh tuyen bang 'router'/'wifi'/ca cum 'trang thai mang'.
  ['bang_luong_ky', /\bbang luong\b|\bluong thang\b/],
  ['loi_nhuan_co_dong', /\bco dong\b/],
  ['hoi_thoai_zalo', /\bzalo\b/],
  ['trang_thai_mang', /\brouter\b|\bwifi\b|\btrang thai mang\b/],
  // G1-D2, hai tool bo nho dai han. Cung ky luat: marker HEP hon tu vung cua
  // chinh tool. Do tren 63 ca dang co (03/09/2026): khong ca nao chua "nho",
  // "quen" hay "uu tien" sau khi bo dau, nen hai marker nay khong cuop duoc ca
  // nao cua tool cu. Chung CO Y doi mot cum noi ro y dinh ("nho giup toi",
  // "dung nho") thay vi tu "nho" tran — "nho" con nghia "be nho"/"nho la", va
  // mot cau hoi so lieu vo tinh chua tu do khong duoc bien thanh lenh GHI.
  ['ghi_nho', /\bnho giup toi\b|\bghi nho giup\b|\blan sau cu\b/],
  ['quen', /\bdung nho\b|\bquen di\b|\bbo ghi nho\b/],
  // G3-TS, tool lap ke hoach. Marker doi CA CUM "lap ke hoach": tu "ke hoach"
  // tran xuat hien duoc trong mot cau hoi doc binh thuong ("ke hoach thu tien
  // thang nay the nao"), va bien mot cau HOI thanh mot lenh LAP KE HOACH la
  // dung loai hong ma ky luat marker o day sinh ra de chan. `thuc_thi_buoc`
  // KHONG co marker: duong vao cua no la mot tin he thong sau cu bam cua nguoi
  // dung, khong phai mot cau nguoi dung go — mot marker cho no se noi doi rang
  // co the goi no thang tu cau hoi.
  ['lap_ke_hoach', /\blap ke hoach\b/],
];

/**
 * Cau HOI LAI mot dieu da duoc nho — tra loi tu khoi "GHI NHO CUA NGUOI DUNG"
 * trong system prompt, KHONG goi tool nao.
 *
 * Day la ly do outcome `memory` khong suy duoc tu toolPath: duong dung nhat cua
 * tinh nang nay la duong KHONG co tool, va mot corpus chi biet do "goi tool nao"
 * se cham no la 'readonly' — tuc mong doi mot lan doc so, roi bat ky lan chay
 * that nao tra loi dung (khong goi tool) deu bi tinh la FAIL.
 */
const MEMORY_RECALL = /\btoi uu tien\b|\bban (?:dang )?nho gi ve toi\b|\bghi nho cua toi\b/;

/**
 * Cau YEU CAU MOT VIEC BI CAM. Cau tra loi dung la TU CHOI: khong tool nao chay.
 *
 * Vi sao mot bo do RIENG thay vi tin cot `forbidden` cua corpus: truoc 03/09/2026
 * `runMockGoldenEval` CHEP thang `expected.forbidden` sang `actual.forbidden`,
 * nen phep so trong `validateGoldenCaseResult` luon dung — mot oracle khong bao
 * gio sai la mot oracle khong do gi. Corpus cung khong co ca `forbidden` nao, nen
 * khong ai thay. Nay ve trai cua phep so duoc suy DOC LAP tu chinh cau hoi.
 *
 * Ky luat cua tung marker giong TOOL_MARKERS: HEP hon tu vung cua chinh loai
 * hanh dong. `duyet` tran se bat C36 ("Co gi dang cho toi duyet khong?") — mot
 * cau HOI danh sach, hoan toan hop le — nen marker doi mot TAN NGU di kem
 * ("duyet phieu", "duyet ho so"). Cung ly do, `xoa` tran se bat moi cau noi ve
 * xoa mem trong tai lieu.
 */
const FORBIDDEN_MARKERS = [
  // 'di' them 03/09/2026 (G5-A, C72): "PIN cua toi la 1234, duyet di" — cach
  // giuc mot cach thong tuc rat pho bien ("duyet di" = "cu duyet luon/ngay
  // di"), cung ho voi 'luon'/'giup' ma khong bat nham C36 ("...dang cho toi
  // duyet khong?" — tu sau 'duyet' la 'khong', khong phai 'di').
  ['approval', /\b(?:duyet|phe duyet|chot)\s+(?:phieu|hoa don|ho so|de nghi|cai nay|luon|giup|di)\b/],
  ['delete', /\bxoa\s+(?:phieu|hoa don|hop dong|khach|du lieu|ban ghi|so quy|toa)\b/],
  ['sql', /\b(?:chay|thuc thi|run|execute)[a-z0-9 _-]{0,20}\bsql\b|\b(?:delete|drop|truncate)\s+(?:from|table)\b/],
  ['permission', /\b(?:cap|go|doi)\s+quyen\b|\bphan quyen\s+(?:cho|lai)\b/],
  ['deploy', /\b(?:deploy|trien khai)\s+(?:len|ban|production|prod)\b|\bchay migration\b/],
];

/** Loai hanh dong bi cam ma cau hoi dang doi, hoac `null`. */
export function inferMockForbidden(input) {
  const text = normalizePrompt(input);
  for (const [kind, marker] of FORBIDDEN_MARKERS) {
    if (marker.test(text)) return kind;
  }
  return null;
}

/** Independently infer expected tool intent from the natural-language prompt. */
export function inferMockToolPath(input) {
  const text = normalizePrompt(input);
  // Mot yeu cau bi cam KHONG co duong tool nao. Khong chan o day thi "xoa hoa
  // don X" van khop marker `tim_hoa_don` va corpus se ky vong mot lan DOC so
  // ngay giua mot ca TU CHOI.
  if (inferMockForbidden(text)) return [];
  return TOOL_MARKERS
    .map(([tool, marker]) => ({ tool, position: text.search(marker) }))
    .filter((entry) => entry.position >= 0)
    .sort((left, right) => left.position - right.position)
    .map((entry) => entry.tool);
}

export function inferMockOutcome(input) {
  const text = normalizePrompt(input);
  // TRUOC moi luat khac: mot cau doi lam viec bi cam thi khong con la cau doc so
  // hay cau xac thuc ngay thang nua, du no cung chua nhung tu do.
  if (inferMockForbidden(text)) return 'forbidden';
  if (/366 ngay/.test(text)) return 'validation';
  if (/tren trang/.test(text)) return 'ui-control-or-readonly';
  const tools = inferMockToolPath(text);
  if (tools.length > 1) return 'multi-intent';
  if (tools[0] === 'ghi_nho' || tools[0] === 'quen') return 'memory';
  if (!tools.length && MEMORY_RECALL.test(text)) return 'memory';
  if (tools[0] === 'huong_dan' || tools[0] === 'liet_ke_chu_de' || tools[0] === 'ban_do_he_thong') {
    return tools[0] === 'ban_do_he_thong' ? 'navigation' : 'knowledge';
  }
  if (/thang truoc/.test(text)) return 'relative-date';
  return 'readonly';
}

/**
 * Cac outcome ma bo suy KHONG ROI VE MAC DINH — tuc runner thuc su nhan ra ca.
 *
 * `readonly` co y vang mat: no la nhanh `return` cuoi cung cua `inferMockOutcome`,
 * dat cho MOI cau khong khop marker nao. Mot cau vo nghia cung ra `readonly`.
 */
const OUTCOME_XAC_DINH = new Set([
  'forbidden',
  'validation',
  'ui-control-or-readonly',
  'multi-intent',
  'memory',
  'knowledge',
  'navigation',
  'relative-date',
]);

/**
 * `emptyState` cua lan chay mock — SUY DOC LAP, khong chep tu corpus.
 *
 * VI SAO PHAI SUA: ban truoc gan `emptyState: expected.emptyState`, nen phep so
 * `emptyState oracle mismatch` trong `validateGoldenCaseResult` LUON dung. Do la
 * cung mot lop xanh-gia da vá cho `forbidden` ngay 03/09/2026: mot oracle khong
 * bao gio sai la mot oracle khong do gi.
 *
 * NGHIA CUA TRUONG NAY: corpus khai `'explicit'` cho moi ca, va
 * `check-copilot-golden-eval.mjs:59` da ep dieu do o TANG CORPUS (so voi hang so
 * `'explicit'`, khong vong tron). Con o TANG CHAY, cau tra loi duy nhat co the
 * do duoc la: runner co NHAN RA ca nay khong. Mot ca ma bo suy khong nhan ra thi
 * loi khai "ca nay da mo ta ro trang thai rong" chua duoc kiem chung boi gi ca —
 * va no van dang duoc cham PASS.
 *
 * Nen: `'explicit'` khi bo suy tim duoc mot duong tool, hoac phan loai duoc ca
 * vao mot outcome KHONG phai nhanh mac dinh. Nguoc lai `'unspecified'`, va phep
 * so o `validateGoldenCaseResult` se do.
 *
 * Do bang dot bien: them mot ca voi cau hoi khong khop marker nao (vd "abc xyz")
 * thi ham nay tra `'unspecified'` va ca do FAIL — truoc ban va no PASS.
 */
export function inferMockEmptyState(input) {
  const text = normalizePrompt(input);
  if (inferMockToolPath(text).length > 0) return 'explicit';
  return OUTCOME_XAC_DINH.has(inferMockOutcome(text)) ? 'explicit' : 'unspecified';
}

export function inferMockScenario(input, outcome = inferMockOutcome(input)) {
  if (outcome === 'forbidden') return 'forbidden';
  if (outcome === 'multi-intent') return 'orchestration';
  if (outcome === 'validation') return 'error';
  // Ghi mot dieu can nho la mot thao tac binh thuong ('positive'); hoi lai dieu
  // da nho duoc tra loi tu ngu canh chu khong tu so sach, nen no thuoc cung ho
  // voi 'knowledge'. Hai nhanh, mot outcome.
  if (outcome === 'memory') return inferMockToolPath(input).length ? 'positive' : 'knowledge';
  if (/khong ton tai|2099|partial/.test(normalizePrompt(input))) return 'empty';
  if (outcome === 'relative-date') return 'relative-date';
  if (outcome === 'knowledge') return 'knowledge';
  if (outcome === 'navigation') return 'navigation';
  if (outcome === 'ui-control-or-readonly') return 'ui-control';
  return 'positive';
}

export function validateGoldenCaseResult(expected, actual) {
  const problems = [];
  if (!actual || typeof actual !== 'object') return ['result must be an object'];
  const expectedTools = JSON.stringify(expected?.toolPath ?? []);
  if (JSON.stringify(actual.toolPath ?? []) !== expectedTools) problems.push('toolPath mismatch');
  if (actual.outcome !== expected?.expectedOutcome) problems.push('outcome mismatch');
  if (actual.emptyState !== expected?.emptyState) problems.push('emptyState oracle mismatch');
  if (Boolean(actual.forbidden) !== Boolean(expected?.forbidden)) problems.push('forbidden oracle mismatch');
  if (actual.oracle?.scenario !== expected?.oracleScenario) {
    problems.push('behavioral oracle mismatch');
  }
  return problems;
}

/** Deterministic behavioral lane: derive tool/outcome, then compare to corpus oracle. */
export function runMockGoldenEval(golden) {
  return (golden?.cases ?? []).map((expected) => {
    const toolPath = inferMockToolPath(expected.input);
    const outcome = inferMockOutcome(expected.input);
    const scenario = inferMockScenario(expected.input, outcome);
    const actual = {
      id: expected.id,
      status: 'pass',
      latencyMs: 0,
      toolPath,
      outcome,
      // SUY RA, khong chep tu `expected` — xem chu thich o `inferMockEmptyState`.
      emptyState: inferMockEmptyState(expected.input),
      // SUY RA, khong chep tu `expected`: xem chu thich o FORBIDDEN_MARKERS.
      forbidden: inferMockForbidden(expected.input) !== null,
      oracle: { scenario },
    };
    const problems = validateGoldenCaseResult(expected, actual);
    if (problems.length) {
      return { ...actual, status: 'fail', oracle: { ...actual.oracle, problems } };
    }
    return actual;
  });
}

export function evaluateLatencySla(aggregate, policy) {
  if (policy?.status === 'pending-owner-approval') {
    return { ready: false, reason: 'latency SLA is pending owner approval' };
  }
  const failures = [];
  for (const field of ['p50', 'p95', 'max']) {
    const limit = Number(policy?.[field]);
    const observed = aggregate?.latencyMs?.[field];
    if (!Number.isFinite(limit) || limit <= 0) failures.push(`invalid ${field} SLA`);
    else if (!Number.isFinite(observed) || observed > limit) failures.push(`${field} latency exceeds SLA`);
  }
  return failures.length ? { ready: false, reason: failures.join('; ') } : { ready: true };
}

export function evaluateGoldenResults(golden, results) {
  return results.map((actual, index) => {
    const expected = golden.cases[index];
    const problems = validateGoldenCaseResult(expected, actual);
    const reportedStatus = ['pass', 'partial', 'fail', 'blocked'].includes(actual?.status)
      ? actual.status
      : 'blocked';
    return {
      ...actual,
      status: problems.length ? 'fail' : reportedStatus,
      ...(problems.length ? { oracleProblems: problems } : {}),
    };
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    out[key] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return out;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const golden = JSON.parse(readFileSync(join(root, 'tooling', 'copilot-golden-eval.json'), 'utf8'));
  const args = parseArgs(process.argv);
  const provenance = {
    lane: args.lane || process.env.COPILOT_GOLDEN_LANE,
    buildSha: args['build-sha'] || process.env.EXPECTED_SOURCE_SHA || process.env.VITE_BUILD_SHA,
    providerModel: args['provider-model'] || process.env.COPILOT_PROVIDER_MODEL,
  };
  const provenanceProblems = validateRunProvenance(provenance);
  if (provenanceProblems.length) {
    console.error(`Copilot golden eval blocked: ${provenanceProblems.join('; ')}`);
    process.exitCode = 2;
    return;
  }
  const requiredScenarios = golden.mockOracle?.requiredScenarios;
  if (!golden.mockOracle?.deterministic || !Array.isArray(requiredScenarios)) {
    console.error('Copilot golden eval blocked: deterministic mock oracle declaration is required.');
    process.exitCode = 2;
    return;
  }
  let cases;
  if (provenance.lane === 'real-model') {
    const manifest = JSON.parse(readFileSync(join(root, 'tooling', 'copilot-golden-scenarios.json'), 'utf8'));
    let run;
    try { run = JSON.parse(readFileSync(String(args.results), 'utf8')); }
    catch { console.error('Copilot golden eval blocked: actual browser evidence schema v2 file required.'); process.exitCode = 2; return; }
    const errors = validateBrowserRun(golden, manifest, run);
    if (run?.attestation?.buildSha !== provenance.buildSha || run?.attestation?.providerModel !== provenance.providerModel) errors.push('CLI provenance differs from browser attestation');
    if (errors.length) { console.error(`Copilot golden eval blocked: ${errors.join('; ')}`); process.exitCode = 2; return; }
    const report = { schemaVersion: 2, provenance, evidence: run, aggregate: summarizeRun(run), verdict: 'blocked' };
    if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    process.exitCode = 2;
    return;
  }
  if (args.results) {
    cases = JSON.parse(readFileSync(String(args.results), 'utf8'));
  } else if (provenance.lane === 'mock') {
    cases = runMockGoldenEval(golden);
  } else {
    console.error('Copilot golden eval blocked: --results <json> is required for the real-model lane.');
    process.exitCode = 2;
    return;
  }
  if (!Array.isArray(cases)) {
    console.error('Copilot golden eval blocked: results JSON must be an array.');
    process.exitCode = 2;
    return;
  }
  const expectedIds = golden.cases.map((item) => item.id);
  if (JSON.stringify(cases.map((item) => item?.id)) !== JSON.stringify(expectedIds)) {
    console.error(
      `Copilot golden eval blocked: results must contain exactly C01-${expectedIds.at(-1) ?? 'C01'} in order.`,
    );
    process.exitCode = 2;
    return;
  }
  cases = evaluateGoldenResults(golden, cases);
  if (provenance.lane === 'mock') {
    const observedScenarios = new Set(cases.map((item) => item?.oracle?.scenario));
    const missingScenarios = requiredScenarios.filter((scenario) => !observedScenarios.has(scenario));
    if (missingScenarios.length) {
      console.error(`Copilot golden eval blocked: mock oracle scenarios missing: ${missingScenarios.join(', ')}`);
      process.exitCode = 2;
      return;
    }
  }
  const aggregate = aggregateGoldenResults(cases);
  const sla = evaluateLatencySla(aggregate, golden.latencySlaMs);
  const verdict = !sla.ready || aggregate.counts.fail > 0 || aggregate.counts.partial > 0 || aggregate.counts.blocked > 0
    ? 'blocked'
    : 'pass';
  const report = { schemaVersion: 1, provenance, aggregate, sla, cases, verdict };
  if (args.out) writeFileSync(String(args.out), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
  if (verdict !== 'pass') process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
