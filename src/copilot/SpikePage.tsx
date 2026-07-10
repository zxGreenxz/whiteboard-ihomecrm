// SpikePage — Phase 0 spike cho AI Copilot (docs/ai-copilot/PLAN.md).
// KHÔNG ship production: trang này chỉ để chạy Gate A/B/C trên branch spike.
// - Gate A: customFetch gắn JWT tươi + header custom cho MỌI request
// - Gate C: interactiveBlacklist sống (repopulate qua event beforeUpdate) loại nút
//   nguy hiểm khỏi browser state; onBeforeStep guard route; transformPageContent
//   mask PII mỗi step; instructions.getPageInstructions nhận URL đúng
// - Đo token/step: đọc usage từ history + promptChars đo tại customFetch
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';

// ── Diagnostics module-level (sống qua unmount khi test route-guard) ────────
interface RequestDiag {
  n: number;
  mockStep: number;
  promptChars: number;
  hasJwt: boolean;
  systemHasMarker: boolean;
  userHasPageCtx: boolean;
  userHasDangerText: boolean;
  userHasRawPhone: boolean;
  userHasMaskedPhone: boolean;
}
interface SpikeDiag {
  fetchCount: number;
  transformCalls: number;
  pageInstructionUrls: string[];
  requests: RequestDiag[];
  steps: { index: number; action: string; usage: unknown }[];
  resultText: string;
  error: string;
  dangerClicks: number;
  counterClicks: number;
  status: string;
}
const emptyDiag = (): SpikeDiag => ({
  fetchCount: 0,
  transformCalls: 0,
  pageInstructionUrls: [],
  requests: [],
  steps: [],
  resultText: '',
  error: '',
  dangerClicks: 0,
  counterClicks: 0,
  status: 'idle',
});
const diag: SpikeDiag = ((window as any).__spikeDiag ??= emptyDiag());

const SYSTEM_MARKER = 'SPIKE_SYSTEM_MARKER_7391';
const PAGE_CTX_MARKER = 'SPIKE_PAGE_CTX_MARKER_7391';
const DANGER_TEXT = 'Xoá hoá đơn TEST-001';
const RAW_PHONE = '0901234567';

const DANGER_RE = /xo[áa]|delete|hu[ỷy]|remove|thanh l[ýy]/i;

function findDangerousElements(): Element[] {
  const out: Element[] = [];
  document
    .querySelectorAll<HTMLElement>('button, a, [role="button"], [data-ai-risk]')
    .forEach((el) => {
      const label = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
      if (el.hasAttribute('data-ai-risk') || DANGER_RE.test(label) || el.closest('[role="alertdialog"]')) {
        out.push(el);
      }
    });
  return out;
}

const maskPii = (content: string) =>
  content.replace(/(\+84|84|0)(\d[\s.]?){8,10}\d?/g, '[SĐT đã ẩn]');

// ── Spike runner ────────────────────────────────────────────────────────────
async function runSpikeTask(opts: {
  model: string;
  task: string;
  routeAllowlist: string[] | null;
}): Promise<void> {
  const { PageAgent } = await import('page-agent');

  Object.assign(diag, emptyDiag(), {
    dangerClicks: diag.dangerClicks,
    counterClicks: diag.counterClicks,
    status: 'running',
  });

  let mockStep = 0;
  const taskId = `spike-${Math.random().toString(36).slice(2, 8)}`;

  const customFetch: typeof fetch = async (input, init) => {
    const { data } = await supabase.auth.getSession();
    const jwt = data.session?.access_token ?? '';
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${jwt}`);
    headers.set('x-copilot-feature', 'spike');
    headers.set('x-task-id', taskId);
    headers.set('x-mock-step', String(mockStep));

    // Diagnostics: soi request body TRƯỚC khi gửi (bằng chứng Gate A/C)
    try {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const msgs: { role: string; content?: string }[] = body.messages ?? [];
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      const user = msgs.find((m) => m.role === 'user')?.content ?? '';
      diag.requests.push({
        n: diag.fetchCount,
        mockStep,
        promptChars: sys.length + user.length,
        hasJwt: jwt.length > 20,
        systemHasMarker: sys.includes(SYSTEM_MARKER) || user.includes(SYSTEM_MARKER),
        userHasPageCtx: user.includes(PAGE_CTX_MARKER) || sys.includes(PAGE_CTX_MARKER),
        userHasDangerText: user.includes('TEST-001'),
        userHasRawPhone: user.includes(RAW_PHONE),
        userHasMaskedPhone: user.includes('[SĐT đã ẩn]'),
      });
    } catch {
      /* body không phải JSON — bỏ qua */
    }

    diag.fetchCount += 1;
    mockStep += 1;
    return fetch(input, { ...init, headers });
  };

  const liveBlacklist: Element[] = [];

  const agent = new PageAgent({
    baseURL: `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/llm-proxy`,
    apiKey: 'unused-behind-proxy',
    model: opts.model,
    maxRetries: 2,
    maxSteps: 8,
    customFetch,
    transformPageContent: (content: string) => {
      diag.transformCalls += 1;
      return maskPii(content);
    },
    instructions: {
      system: `${SYSTEM_MARKER} Bạn là trợ lý thao tác trang ptcrm. Trả lời tiếng Việt.`,
      getPageInstructions: (url: string) => {
        diag.pageInstructionUrls.push(url);
        return `${PAGE_CTX_MARKER} path=${new URL(url).pathname}`;
      },
    },
    onBeforeStep: () => {
      if (opts.routeAllowlist && !opts.routeAllowlist.includes(window.location.pathname)) {
        throw new Error(`ROUTE_GUARD: ${window.location.pathname} ngoài allowlist`);
      }
    },
    interactiveBlacklist: liveBlacklist,
  });

  // Blacklist "sống": repopulate NGAY TRƯỚC mỗi lần dựng tree (event beforeUpdate).
  // (npm 1.11.0 chưa có [data-page-agent-not-interactive] như branch main —
  //  mutate mảng in-place cho hiệu quả tương đương.)
  agent.pageController.addEventListener('beforeUpdate', () => {
    liveBlacklist.length = 0;
    liveBlacklist.push(...findDangerousElements());
  });

  (window as any).__spikeAgent = agent;

  try {
    const result = await agent.execute(opts.task);
    diag.status = result.success ? 'completed' : 'failed';
    diag.resultText = result.data;
    diag.steps = result.history
      .filter((h): h is Extract<typeof h, { type: 'step' }> => h.type === 'step')
      .map((h) => ({ index: h.stepIndex, action: h.action.name, usage: h.usage }));
  } catch (e) {
    diag.status = 'threw';
    diag.error = e instanceof Error ? e.message : String(e);
  }
}

// Cho phép chạy spike từ console trên TRANG BẤT KỲ (đo token trang danh sách lớn)
(window as any).__spikeRun = runSpikeTask;

// ── UI ───────────────────────────────────────────────────────────────────────
export default function SpikePage() {
  const [model, setModel] = useState('mock:done');
  const [task, setTask] = useState('Kiểm tra trang này.');
  const [guardOn, setGuardOn] = useState(false);
  const [, force] = useState(0);
  const navigate = useNavigate();
  const timerRef = useRef<number>();

  useEffect(() => {
    timerRef.current = window.setInterval(() => force((x) => x + 1), 500);
    return () => window.clearInterval(timerRef.current);
  }, []);

  const run = (m: string, t: string, guard: boolean) => {
    void runSpikeTask({
      model: m,
      task: t,
      routeAllowlist: guard ? ['/copilot-spike'] : null,
    });
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6" data-testid="spike-root">
      <h1 className="text-xl font-bold">AI Copilot — Phase 0 Spike</h1>

      {/* Playground cho agent thao tác */}
      <div className="border rounded p-4 space-y-3">
        <h2 className="font-semibold">Playground</h2>
        <p>
          Khách hàng: Nguyễn Văn A — SĐT {RAW_PHONE} — CCCD 079123456789
        </p>
        <div className="flex gap-2 flex-wrap">
          <button
            className="border rounded px-3 py-1"
            data-testid="counter-btn"
            onClick={() => { diag.counterClicks += 1; }}
          >
            Đếm số lần bấm ({diag.counterClicks})
          </button>
          <button
            className="border rounded px-3 py-1 text-red-600"
            data-testid="danger-btn"
            onClick={() => { diag.dangerClicks += 1; }}
          >
            {DANGER_TEXT}
          </button>
          <button
            className="border rounded px-3 py-1 text-red-600"
            data-ai-risk="submit"
            data-testid="risk-attr-btn"
            onClick={() => { diag.dangerClicks += 1; }}
          >
            Gửi biểu mẫu quan trọng
          </button>
        </div>
        <input className="border rounded px-2 py-1 w-64" placeholder="Ô nhập thử" data-testid="spike-input" />
      </div>

      {/* Điều khiển spike */}
      <div className="border rounded p-4 space-y-3">
        <h2 className="font-semibold">Chạy task</h2>
        <div className="flex gap-2 items-center flex-wrap">
          <input className="border rounded px-2 py-1 w-72" value={model} onChange={(e) => setModel(e.target.value)} data-testid="model-input" />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={guardOn} onChange={(e) => setGuardOn(e.target.checked)} data-testid="guard-toggle" />
            Route guard
          </label>
        </div>
        <textarea className="border rounded px-2 py-1 w-full" rows={2} value={task} onChange={(e) => setTask(e.target.value)} data-testid="task-input" />
        <div className="flex gap-2 flex-wrap">
          <button className="border rounded px-3 py-1 bg-blue-600 text-white" data-testid="run-btn" onClick={() => run(model, task, guardOn)}>
            Chạy
          </button>
          <button className="border rounded px-3 py-1" data-testid="run-echo-btn" onClick={() => run('mock:echo', 'Echo prompt.', false)}>
            Mock echo (soi prompt)
          </button>
          <button
            className="border rounded px-3 py-1"
            data-testid="run-guard-btn"
            onClick={() => {
              run('mock:wait-wait-wait-done', 'Chờ rồi xong.', true);
              window.setTimeout(() => navigate('/dashboard'), 1800);
            }}
          >
            Test route-guard (tự rời trang giữa task)
          </button>
        </div>
      </div>

      {/* Diagnostics */}
      <div className="border rounded p-4">
        <h2 className="font-semibold">Diagnostics</h2>
        <pre className="text-xs whitespace-pre-wrap break-all" data-testid="diag">
          {JSON.stringify(diag, null, 2)}
        </pre>
      </div>
    </div>
  );
}
