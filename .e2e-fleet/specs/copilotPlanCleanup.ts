import type { Page, Request } from '@playwright/test';

export interface PlanCleanupRpcResult {
  status: number;
  body: unknown;
}

export interface PlanCleanupDocument {
  organization_id: string;
  plan_status: string;
  plan_version: number;
}

interface PlanCreateBody extends Partial<PlanCleanupDocument> {
  ok?: boolean;
  da_ton_tai?: boolean;
  plan_id?: string;
}

interface PlanCleanupOptions {
  page: Page;
  actor: string;
  organizationId: string;
  marker: string;
  readPlan: (planId: string) => Promise<PlanCleanupDocument>;
  cancelPlan: (planId: string, version: number) => Promise<PlanCleanupRpcResult>;
  settleTimeoutMs?: number;
}

export interface PlanCleanupResult {
  freshPlanIds: string[];
  replayedPlanIds: string[];
  startedRequests: number;
}

interface PlanRequestState {
  actorOwned: boolean;
  done: Promise<void>;
  evidence: string;
  markerPresent: boolean;
  organizationOwned: boolean;
  request: Request;
  settled: boolean;
}

function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jwtSubject(jwt: string): string {
  const encoded = jwt.split('.')[1];
  requireEvidence(encoded, 'JWT plan create không có payload');
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const subject = (JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as { sub?: string }).sub;
  requireEvidence(subject, 'JWT plan create không có claim `sub`');
  return subject;
}

function textEvidence(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '<missing>';
  return value.slice(0, 200).replace(/[\r\n]/g, ' ');
}

function finishError(errors: string[]): never {
  throw new Error(`Plan-create cleanup không đủ bằng chứng:\n- ${errors.join('\n- ')}`);
}

const PLAN_CREATE_PATH = /\/rpc\/copilot_plan_create_v1$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function taoBoThuGomKeHoachChat(options: PlanCleanupOptions): {
  finish: (quiesce?: () => Promise<void>) => Promise<PlanCleanupResult>;
  startedCount: () => number;
} {
  const errors: string[] = [];
  const freshPlanIds = new Set<string>();
  const replayedPlanIds = new Set<string>();
  const started: PlanRequestState[] = [];
  const settleTimeoutMs = options.settleTimeoutMs ?? 30_000;

  const inspect = async (state: PlanRequestState) => {
    let response;
    try {
      response = await state.request.response();
    } catch (error) {
      errors.push(`Không xác định được kết quả transport plan create: ${messageOf(error)} [${state.evidence}]`);
      return;
    }
    if (!response) {
      errors.push(`Transport plan create kết thúc nhưng không có response; không được giả định server chưa ghi [${state.evidence}]`);
      return;
    }
    if (!response.ok()) return;
    const streamError = await response.finished();
    if (streamError) {
      errors.push(`Response plan create bị đứt: ${streamError.message} [${state.evidence}]`);
      return;
    }

    let created: PlanCreateBody;
    try {
      created = (await response.json()) as PlanCreateBody;
    } catch (error) {
      errors.push(`Không đọc được JSON plan create thành công: ${messageOf(error)} [${state.evidence}]`);
      return;
    }
    if (created.ok === false) return;
    if (created.ok !== true) {
      errors.push(`Plan create HTTP 2xx không xác nhận \`ok: true\` [${state.evidence}]`);
      return;
    }
    if (!created.plan_id || !UUID.test(created.plan_id)) {
      errors.push(`Plan create thành công không trả plan_id UUID [${state.evidence}]`);
      return;
    }
    const responseOrganizationOwned = created.organization_id === options.organizationId;
    if (!responseOrganizationOwned) {
      errors.push(`Plan create trả về sai tổ chức [${state.evidence}]`);
    }
    if (created.da_ton_tai === true) {
      replayedPlanIds.add(created.plan_id);
      return;
    }
    if (created.da_ton_tai !== false) {
      errors.push(`Plan create không cho biết đây là tạo mới hay phát lại [${state.evidence}]`);
      return;
    }
    if (!responseOrganizationOwned) return;
    if (created.plan_status !== 'DRAFT') {
      errors.push(`Plan mới không ở DRAFT nên cleanup không được chạm vào [${state.evidence}]`);
      return;
    }
    if (state.actorOwned && state.organizationOwned) freshPlanIds.add(created.plan_id);
  };

  const onRequest = (request: Request) => {
    if (request.method() !== 'POST' || !PLAN_CREATE_PATH.test(new URL(request.url()).pathname)) return;
    const requestBody = (() => {
      try {
        return request.postDataJSON() as Record<string, unknown>;
      } catch (error) {
        errors.push(`Không đọc được body plan create: ${messageOf(error)}`);
        return {};
      }
    })();
    let requestActor = '<unreadable>';
    try {
      const bearer = request.headers().authorization?.replace(/^Bearer /i, '');
      requireEvidence(bearer, 'Plan create phải mang JWT của actor đang kiểm');
      requestActor = jwtSubject(bearer);
    } catch (error) {
      errors.push(`Không xác minh được actor plan create: ${messageOf(error)}`);
    }
    const markerPresent = JSON.stringify(requestBody.p_steps).includes(options.marker);
    const evidence = [
      `request=${started.length + 1}`,
      `method=${request.method()}`,
      `path=${new URL(request.url()).pathname}`,
      `actor=${textEvidence(requestActor)}`,
      `organization=${textEvidence(requestBody.p_organization_id)}`,
      `client_request_id=${textEvidence(requestBody.p_client_request_id)}`,
      `marker_present=${markerPresent}`,
    ].join(' ');
    const state: PlanRequestState = {
      actorOwned: requestActor === options.actor,
      done: Promise.resolve(),
      evidence,
      markerPresent,
      organizationOwned: requestBody.p_organization_id === options.organizationId,
      request,
      settled: false,
    };
    started.push(state);
    if (!state.actorOwned) errors.push(`Plan create không thuộc actor của ca kiểm [${state.evidence}]`);
    if (!state.organizationOwned) errors.push(`Plan create không thuộc org DEMO [${state.evidence}]`);
    // Marker là một assertion độc lập. Thiếu marker vẫn phải thu gom một DRAFT
    // mới đã được chứng minh bằng actor + org + response `da_ton_tai: false`.
    if (!state.markerPresent) errors.push(`Plan create thiếu marker riêng của ca kiểm [${state.evidence}]`);
    state.done = inspect(state)
      .catch((error) => {
        errors.push(`Lỗi khi phân loại plan create: ${messageOf(error)} [${state.evidence}]`);
      })
      .finally(() => { state.settled = true; });
  };
  options.page.on('request', onRequest);

  const settleStartedRequests = async () => {
    const deadline = Date.now() + settleTimeoutMs;
    for (;;) {
      const count = started.length;
      const pending = started.filter((state) => !state.settled);
      if (pending.length > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          errors.push(
            `Hết thời gian chờ kết quả transport; không được tuyên bố cleanup cho ${pending.map((state) => `[${state.evidence}]`).join(' ')}`,
          );
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
          Promise.all(pending.map((state) => state.done)).then(() => false),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), remaining); }),
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) {
          const unresolved = started.filter((state) => !state.settled);
          errors.push(
            `Hết thời gian chờ kết quả transport; không được tuyên bố cleanup cho ${unresolved.map((state) => `[${state.evidence}]`).join(' ')}`,
          );
          return;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (started.length === count && started.every((state) => state.settled)) return;
    }
  };

  return {
    startedCount: () => started.length,
    async finish(quiesce) {
      try {
        if (quiesce) {
          try {
            await quiesce();
          } catch (error) {
            errors.push(`Không gửi được lệnh dừng chat: ${messageOf(error)}`);
          }
          try {
            await options.page.getByTestId('copilot-send').waitFor({
              state: 'visible',
              timeout: settleTimeoutMs,
            });
          } catch (error) {
            errors.push(`Chat không về trạng thái yên sau lệnh dừng: ${messageOf(error)}`);
          }
        }
        await settleStartedRequests();

        for (const planId of freshPlanIds) {
          try {
            const plan = await options.readPlan(planId);
            requireEvidence(plan.organization_id === options.organizationId, 'Plan trước cleanup không còn thuộc org DEMO');
            requireEvidence(plan.plan_status === 'DRAFT', 'Cleanup không được chạm plan đã duyệt/đang chạy');
            requireEvidence(Number.isInteger(plan.plan_version), 'Plan DRAFT không có version nguyên để cancel có điều kiện');
            const cancel = await options.cancelPlan(planId, plan.plan_version);
            requireEvidence(cancel.status === 200, `Không huỷ được plan DRAFT ${planId} (HTTP ${cancel.status})`);
            requireEvidence((await options.readPlan(planId)).plan_status === 'CANCELLED', `Plan ${planId} vẫn còn mở sau cleanup`);
          } catch (error) {
            errors.push(`Cleanup plan mới ${planId} thất bại: ${messageOf(error)}`);
          }
        }
      } finally {
        options.page.off('request', onRequest);
      }

      if (errors.length > 0) finishError(errors);
      return {
        freshPlanIds: [...freshPlanIds],
        replayedPlanIds: [...replayedPlanIds],
        startedRequests: started.length,
      };
    },
  };
}
