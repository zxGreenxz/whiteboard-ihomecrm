import type { Page, Response, Route } from '@playwright/test';

// User-selected Gemini models on the VPS, with 3.6 evaluated first. This is a test preference,
// not a claim of live response quality. No automatic fallback on transport or
// quota errors; choose another candidate only after an explicit measured decision.
export const COPILOT_TEST_MODEL_CANDIDATES = [
  '9router:ag/gemini-3.6-flash-high(high)',
  '9router:ag/gemini-3.7-flash-high(high)',
  '9router:ag/gemini-3.8-flash(high)',
] as const;
export const COPILOT_TEST_MODEL = process.env.COPILOT_E2E_MODEL || COPILOT_TEST_MODEL_CANDIDATES[0];

interface ModelPinOptions {
  fetchTimeoutMs?: number;
}

export interface CopilotTestModelPin {
  dispose: () => Promise<void>;
}

function safeRouteError(route: Route, kind: string, status?: number): Error {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  return new Error(
    `${request.method()} ${path} ${kind}${status === undefined ? '' : ` status=${status}`}`,
  );
}

export async function pinCopilotTestModel(
  page: Page,
  options: ModelPinOptions = {},
): Promise<CopilotTestModelPin> {
  // Rewrite only this browser's preference READ response. Never persist a model
  // selection (changing the picker would write the profile on the server).
  const pattern = '**/rest/v1/profiles?*';
  const pending = new Set<Promise<void>>();
  const failures: Error[] = [];
  const handle = async (route: Route): Promise<void> => {
    const request = route.request();
    try {
      if (
        request.method() !== 'GET' ||
        new URL(request.url()).searchParams.get('select') !== 'ui_preferences'
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch({ timeout: options.fetchTimeoutMs ?? 15_000 });
      if (!response.ok()) {
        failures.push(safeRouteError(route, 'upstream_error', response.status()));
        await route.fulfill({ response });
        return;
      }
      let profile: { ui_preferences?: Record<string, unknown> };
      try {
        profile = (await response.json()) as { ui_preferences?: Record<string, unknown> };
      } catch {
        failures.push(safeRouteError(route, 'invalid_json', response.status()));
        await route.fulfill({ response });
        return;
      }
      await route.fulfill({
        response,
        json: {
          ...profile,
          ui_preferences: {
            ...profile.ui_preferences,
            copilotModel: COPILOT_TEST_MODEL,
          },
        },
      });
    } catch {
      failures.push(safeRouteError(route, 'transport_error'));
      await route.abort('failed').catch(() => undefined);
    }
  };
  const handler = (route: Route) => {
    const task = handle(route);
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };
  await page.route(pattern, handler);

  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      await page.unroute(pattern, handler).catch(() => {
        failures.push(new Error('GET /rest/v1/profiles unroute_error'));
      });
      await Promise.all([...pending]);
      if (failures.length > 0) {
        throw new Error([...new Set(failures.map((failure) => failure.message))].join('\n'));
      }
    },
  };
}

function isDemoAvailability(response: Response, organizationId: string): boolean {
  const request = response.request();
  if (
    request.method() !== 'POST' ||
    !new URL(response.url()).pathname.endsWith('/rpc/get_my_copilot_availability_v1')
  ) {
    return false;
  }
  try {
    return request.postDataJSON().p_organization_id === organizationId;
  } catch {
    return false;
  }
}

export async function waitForCopilotAvailability(
  page: Page,
  organizationId: string,
  trigger: () => Promise<unknown>,
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  // Register before the action that can reveal/start Copilot. A visible model
  // picker is not proof that this separate RPC has returned. This helper owns
  // one deadline through trigger completion and the full response body.
  const timeoutMs = options.timeoutMs ?? 15_000;
  const availabilityPath = '/rpc/get_my_copilot_availability_v1';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let triggerDone = false;
  let responseDone = false;
  let responseClaimed = false;
  let completedResponse: Response | undefined;
  let resolveProof!: (response: Response) => void;
  let rejectProof!: (error: unknown) => void;
  const proof = new Promise<Response>((resolve, reject) => {
    resolveProof = resolve;
    rejectProof = reject;
  });
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectProof(error);
  };
  const complete = () => {
    if (settled || !triggerDone || !responseDone || !completedResponse) return;
    settled = true;
    resolveProof(completedResponse);
  };
  const onResponse = (response: Response) => {
    if (settled || responseClaimed || !isDemoAvailability(response, organizationId)) return;
    responseClaimed = true;
    void response.finished().then(
      (transportError) => {
        if (settled) return;
        const path = new URL(response.url()).pathname;
        if (transportError) {
          fail(new Error(`POST ${path} transport_error status=${response.status()}`));
          return;
        }
        if (!response.ok()) {
          fail(new Error(`POST ${path} upstream_error status=${response.status()}`));
          return;
        }
        completedResponse = response;
        responseDone = true;
        complete();
      },
      () => fail(new Error(`POST ${availabilityPath} transport_error`)),
    );
  };
  page.on('response', onResponse);
  timer = setTimeout(
    () => fail(new Error(`Timed out after ${timeoutMs}ms waiting for completed response ${availabilityPath}`)),
    timeoutMs,
  );
  void Promise.resolve()
    .then(trigger)
    .then(
      () => {
        triggerDone = true;
        complete();
      },
      fail,
    );
  try {
    return await proof;
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    page.off('response', onResponse);
  }
}
