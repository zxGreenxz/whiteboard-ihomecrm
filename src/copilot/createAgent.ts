// UI-control agent (Phase 3, EXPERIMENTAL — PLAN.md v2.1). Dựng PageAgent với:
// - customFetch: JWT tươi + header feature=ui_control (proxy ghi usage + gate)
// - transformPageContent: maskPii mỗi step
// - instructions OBJECT {system, getPageInstructions}
// - customTools: execute_javascript=null (chặn thoát sandbox) + domain tools
// - interactiveBlacklist SỐNG + beforeUpdate stamping (safetyGuard)
// - onBeforeStep route allowlist guard
// LƯU Ý: execute() reset history mỗi task → mỗi lệnh ĐỘC LẬP.
import { PageAgent } from 'page-agent';
import { LLM_PROXY_BASE, makeCopilotFetch, newTaskId, parseProviderModel } from './copilotConfig';
import { maskPii } from './maskPii';
import { UI_CONTROL_SYSTEM_PROMPT } from './systemPromptVi';
import { pageContext } from './pageContext';
import {
  attachDangerStamping,
  makeRouteGuard,
  PILOT_ROUTE_ALLOWLIST,
} from './safetyGuard';
import { buildRegistry, toPageAgentTools, type ToolCtx } from './tools/registry';

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
  if (parsed.provider === 'ollama') {
    throw new Error('UI-control chưa hỗ trợ Ollama (local) — dùng provider cloud.');
  }

  const allowlist = params.allowlist ?? PILOT_ROUTE_ALLOWLIST;
  const taskId = newTaskId('ui');
  const liveBlacklist: Element[] = [];

  const registry = buildRegistry();
  const domainTools = toPageAgentTools(registry, params.ctx);

  const agent = new PageAgent({
    baseURL: LLM_PROXY_BASE,
    apiKey: 'unused-behind-proxy',
    model: params.providerModel,
    maxRetries: 2, // retry CHỈ ở client (proxy không retry — F4)
    maxSteps: 25,
    customFetch: makeCopilotFetch('ui_control', taskId),
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
    onBeforeStep: makeRouteGuard(allowlist),
    customTools: {
      execute_javascript: null, // chặn thoát sandbox / bypass mask
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
