// UI-control agent (Phase 3, EXPERIMENTAL — PLAN.md v2.1). Dựng PageAgent với:
// - customFetch: JWT tươi + header feature=ui_control (proxy ghi usage + gate)
// - transformPageContent: maskPii mỗi step
// - instructions OBJECT {system, getPageInstructions}
// - customTools: execute_javascript=null (chặn thoát sandbox) + domain tools
// - interactiveBlacklist SỐNG + beforeUpdate stamping (safetyGuard)
// - onBeforeStep route allowlist guard
// LƯU Ý: execute() reset history mỗi task → mỗi lệnh ĐỘC LẬP.
import { PageAgent } from 'page-agent';
import { LLM_PROXY_BASE, LOCAL_PROVIDER_BASES, makeCopilotFetch, newTaskId, parseProviderModel } from './copilotConfig';
import { maskPii } from './maskPii';
import { UI_CONTROL_SYSTEM_PROMPT } from './systemPromptVi';
import { pageContext } from './pageContext';
import {
  attachDangerStamping,
  PILOT_ROUTE_ALLOWLIST,
} from './safetyGuard';
import { buildRegistry, toPageAgentTools, type ToolCtx } from './tools/registry';
import { copilotPageByRoute } from '@/app/capabilities/registry';
import { hopDongTuPageContract, taoCongCuDieuKhienAnToan } from './safeControls';
import {
  assertUiControlAvailability,
  assertUiControlPageContract,
  makeUiControlStepGuard,
} from './uiControlAvailability';

export interface UiControlAgent {
  run: (task: string) => Promise<{ success: boolean; data: string }>;
  stop: () => Promise<void>;
  dispose: () => void;
}

export function createUiControlAgent(params: {
  providerModel: string;
  ctx: ToolCtx; // { perms, navigate }
  allowlist?: string[];
}): UiControlAgent {
  const parsed = parseProviderModel(params.providerModel);
  if (!parsed) throw new Error(`Model không hợp lệ: "${params.providerModel}"`);
  if (LOCAL_PROVIDER_BASES[parsed.provider]) {
    throw new Error('UI-control chưa hỗ trợ provider local (Ollama/9Router) — dùng provider cloud.');
  }

  assertUiControlAvailability({
    pathname: window.location.pathname,
    ctx: params.ctx,
  });

  const allowlist = params.allowlist ?? PILOT_ROUTE_ALLOWLIST;
  const taskId = newTaskId('ui');
  const liveBlacklist: Element[] = [];

  const registry = buildRegistry(params.ctx.availability);
  const domainTools = toPageAgentTools(registry, params.ctx);
  const pageContract = copilotPageByRoute(window.location.pathname)!;
  const semanticTools = taoCongCuDieuKhienAnToan(
    hopDongTuPageContract(pageContract),
    document,
    {
      beforeDispatch: () => {
        // Step-level guards do not cover a route transition between tool
        // selection and the actual DOM mutation.
        assertUiControlPageContract(window.location.pathname, pageContract.key, params.ctx);
      },
    },
  );

  const guardCurrentStep = makeUiControlStepGuard(params.ctx, allowlist);

  const agent = new PageAgent({
    baseURL: LLM_PROXY_BASE,
    apiKey: 'unused-behind-proxy',
    model: params.providerModel,
    maxRetries: 2, // retry CHỈ ở client (proxy không retry — F4)
    maxSteps: 25,
    customFetch: makeCopilotFetch('ui_control', taskId, params.ctx.organizationId),
    transformPageContent: (content: string) => maskPii(content),
    instructions: {
      system: UI_CONTROL_SYSTEM_PROMPT,
      getPageInstructions: (url: string) => {
        try {
          return pageContext(new URL(url).pathname);
        } catch {
          return null;
        }
      },
    },
    onBeforeStep: guardCurrentStep,
    customTools: {
      execute_javascript: null, // chặn thoát sandbox / bypass mask
      //
      // TOOL MANG CHỈ SỐ — tắt hết, và đây là chốt chặn THẬT của UI-control.
      //
      // Ba tool này nhận một số nguyên trỏ vào bảng phần tử tương tác do thư
      // viện tự dựng. Vấn đề không phải mô hình chọn nhầm số: vấn đề là BẢNG đó
      // chứa mọi thứ heuristic cho là tương tác được — tức gần như toàn bộ giao
      // diện. Một tool nhận chỉ số vào bảng đó là một tool chạm được mọi nút.
      //
      // Vì sao không dùng `interactiveWhitelist` để thu hẹp bảng: đo trên chính
      // bundle 1.11.0 (xem `pageAgentCompatibility.ts` + test của nó), whitelist
      // là ADDITIVE chứ không phải bộ lọc —
      //     if (blacklist.includes(el)) return false;
      //     if (whitelist.includes(el)) return true;
      //     … heuristic vẫn chạy tiếp …
      // Phần tử ngoài whitelist vẫn tương tác được. Muốn mặc-định-từ-chối thì
      // phải liệt kê PHẦN BÙ vào blacklist, mà phần bù đó không dựng nổi từ mã
      // ứng dụng: bộ duyệt của thư viện đi vào open shadow root và same-origin
      // iframe, còn `querySelectorAll('*')` thì không.
      //
      // Nên `interactiveBlacklist` bên dưới GIỮ NGUYÊN vai trò phòng thủ theo
      // chiều sâu (nó bắt nút nguy hiểm theo nhãn), nhưng nó KHÔNG còn là thứ
      // đang gánh trách nhiệm chính. Trách nhiệm đó nay nằm ở việc mô hình
      // không có tool nào để chỉ vào một phần tử tuỳ ý.
      click_element_by_index: null,
      input_text: null,
      select_dropdown_option: null,
      ...semanticTools,
      ...domainTools,
    },
    interactiveBlacklist: liveBlacklist,
  });

  const detach = attachDangerStamping(agent, liveBlacklist);

  return {
    run: async (task: string) => {
      const result = await agent.execute(task);
      return { success: result.success, data: result.data };
    },
    stop: () => agent.stop(),
    dispose: () => {
      detach();
      agent.dispose();
    },
  };
}
