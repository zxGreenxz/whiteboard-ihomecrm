// Handler contract for the measured 9Router 0.5.69 Gemini EOF without [DONE].
// Only external auth/RPC/fetch are faked: assertions read actual proxy bytes.
import type { AdminToiThieu } from "./index.ts";

Deno.env.set("NINEROUTER_BASE_URL", "https://9router-gia.test/v1");
const proxy = import("./index.ts");
const enc = new TextEncoder();
const MODEL = "ag/gemini-3.6-flash-high(high)";
const DONE = "\n\ndata: [DONE]\n\n";
const USAGE = {
  prompt_tokens: 11,
  completion_tokens: 7,
  total_tokens: 18,
  prompt_tokens_details: { cached_tokens: 3 },
};
const MESSAGES = [{ role: "user", content: "chào" }];

function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label}: actual=${JSON.stringify(actual)}, expected=${
        JSON.stringify(expected)
      }`,
    );
  }
}

function frame(delta: unknown, finish: string | null = null, usage?: unknown) {
  return `data: ${
    JSON.stringify({
      id: "synthetic-gemini",
      object: "chat.completion.chunk",
      created: 1788715910,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })
  }\n\n`;
}
const CONTENT = frame({ role: "assistant", content: "Xin chào 🌿" });
const STOP = frame({}, "stop", USAGE);

async function handler(
  source: ReadableStream<Uint8Array>,
  options: { provider?: string; model?: string; signal?: AbortSignal } = {},
) {
  const { xuLyYeuCau } = await proxy;
  const provider = options.provider ?? "9router";
  const model = options.model ?? MODEL;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const admin: AdminToiThieu = {
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: "user-gia" } }, error: null }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                provider,
                enabled: true,
                data_class: "cloud",
                models: [
                  {
                    id: model,
                    pricing_mode: "metered",
                    input_price: 2,
                    output_price: 4,
                  },
                ],
              },
              error: null,
            }),
        }),
      }),
    }),
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({
        data: name === "reserve_ai_usage" ? "reservation-gia" : null,
        error: null,
      });
    },
  };
  let upstreamSignal: AbortSignal | null | undefined;
  let upstreamBody: Record<string, unknown> = {};
  const res = await xuLyYeuCau(
    new Request("https://proxy.test/chat/completions", {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: "Bearer jwt-gia",
        "Content-Type": "application/json",
        "x-organization-id": "33333333-3333-4333-8333-333333333333",
      },
      body: JSON.stringify({
        model: `${provider}:${model}`,
        stream: true,
        messages: MESSAGES,
      }),
    }),
    {
      admin,
      getEnv: (key) => key.endsWith("API_KEY") ? "key-gia" : undefined,
      fetchImpl: (_url, init) => {
        upstreamSignal = init?.signal;
        upstreamBody = JSON.parse(String(init?.body));
        return Promise.resolve(
          new Response(source, {
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      },
    },
  );
  equal(res.status, 200, "handler reaches stream");
  equal(
    upstreamBody.stream_options,
    { include_usage: true },
    "request still asks for vendor usage",
  );
  return { res, calls, upstreamSignal };
}

function closed(bytes: Uint8Array, stride = bytes.length) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (offset >= bytes.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(bytes.slice(offset, offset + stride));
      offset += stride;
    },
  });
}

function usageUnchanged(calls: Awaited<ReturnType<typeof handler>>["calls"]) {
  const final = calls.filter((call) => call.name === "finalize_ai_usage");
  equal(
    calls.filter((call) => call.name === "reserve_ai_usage").length,
    1,
    "one reservation",
  );
  equal(final.length, 1, "exactly one finalize");
  const {
    p_prompt_tokens,
    p_completion_tokens,
    p_total_tokens,
    p_cached_tokens,
    p_cost_usd,
  } = final[0].args;
  equal(
    [p_prompt_tokens, p_completion_tokens, p_total_tokens, p_cached_tokens],
    [11, 7, 18, 3],
    "real vendor usage survives",
  );
  equal(
    p_cost_usd,
    11 / 1e6 * 2 + 7 / 1e6 * 4,
    "cost still follows real usage",
  );
}

Deno.test("Gemini terminal: normal stop EOF appends one DONE and preserves bytes/usage", async () => {
  const input = CONTENT + STOP;
  const { res, calls } = await handler(closed(enc.encode(input)));
  equal(await res.text(), input + DONE, "normal stop EOF must append DONE");
  usageUnchanged(calls);
});

Deno.test("Gemini terminal: tool_calls EOF preserves the whole tool lifecycle", async () => {
  const input = frame({
    role: "assistant",
    tool_calls: [{
      index: 0,
      id: "call-gia",
      type: "function",
      function: { name: "read_rooms", arguments: '{"query":' },
    }],
  }) +
    frame({ tool_calls: [{ index: 0, function: { arguments: '"phòng"}' } }] }) +
    frame({}, "tool_calls", USAGE);
  const { res, calls } = await handler(closed(enc.encode(input), 7));
  equal(await res.text(), input + DONE, "tool_calls EOF must append DONE");
  usageUnchanged(calls);
});

Deno.test("Gemini terminal: UTF-8, CRLF, and final data line without newline", async () => {
  const input = (CONTENT + STOP).replaceAll("\n", "\r\n").trimEnd();
  const { res, calls } = await handler(closed(enc.encode(input), 1));
  equal(
    await res.text(),
    input + DONE,
    "arbitrary byte splits and unterminated final line",
  );
  usageUnchanged(calls);
});

Deno.test("Gemini terminal: existing DONE is never duplicated even without newline", async () => {
  const input = CONTENT + STOP + "data: [DONE]";
  const { res, calls } = await handler(closed(enc.encode(input), 1));
  equal(await res.text(), input, "existing DONE stays byte-identical");
  usageUnchanged(calls);
});

for (
  const [provider, model] of [
    ["9router", "cx/gpt-5.6-sol(max)"],
    ["9router", "ag/claude-sonnet"],
    ["9router", "gemini-3.6-flash-high(high)"],
    ["openrouter", MODEL],
    ["gemini", MODEL],
  ]
) {
  Deno.test(`Gemini terminal: scope leaves ${provider}:${model} unchanged`, async () => {
    const input = CONTENT + STOP;
    const { res, calls } = await handler(closed(enc.encode(input)), {
      provider,
      model,
    });
    equal(
      await res.text(),
      input,
      "unmatched provider/model must remain unchanged",
    );
    usageUnchanged(calls);
  });
}

for (
  const [name, input] of [
    ["missing finish", CONTENT],
    ["length", CONTENT + frame({}, "length", USAGE)],
    ["content_filter", CONTENT + frame({}, "content_filter", USAGE)],
    ["unknown finish", CONTENT + frame({}, "error", USAGE)],
    [
      "quota before stop",
      'data: {"error":{"code":"insufficient_quota"}}\n\n' + CONTENT + STOP,
    ],
    [
      "rate error after stop",
      CONTENT + STOP + 'data: {"error":{"code":"rate_limit_exceeded"}}\n\n',
    ],
    [
      "SSE error event",
      CONTENT + STOP + 'event: error\ndata: {"choices":[],"usage":{}}\n\n',
    ],
    [
      "typed error envelope",
      CONTENT + STOP +
      `data: ${
        JSON.stringify({ type: "error", choices: [], usage: USAGE })
      }\n\n`,
    ],
    ["malformed usage", CONTENT + STOP + 'data: {"choices":[],"usage":{}}\n\n'],
    [
      "error beside valid finish",
      CONTENT + STOP.replace('"usage":', '"error":{"code":"quota"},"usage":'),
    ],
    [
      "malformed tool delta",
      frame({ tool_calls: [null] }) + frame({}, "tool_calls", USAGE),
    ],
    ["malformed before stop", "data: {broken}\n\n" + CONTENT + STOP],
    ["truncated JSON after stop", CONTENT + STOP + 'data: {"choices":'],
    [
      "malformed choices",
      CONTENT +
      'data: {"choices":[{"index":0,"delta":null,"finish_reason":"stop"}]}\n\n',
    ],
    ["content after stop", CONTENT + STOP + CONTENT],
    [
      "second unfinished choice",
      CONTENT +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":null}]}\n\n',
    ],
    ["oversized SSE event", CONTENT + STOP + `: ${"x".repeat(140_000)}\n\n`],
  ]
) {
  Deno.test(`Gemini terminal: ${name} cannot become successful`, async () => {
    const { res, calls } = await handler(closed(enc.encode(input), 127));
    equal(await res.text(), input, `${name} must not synthesize DONE`);
    equal(
      calls.filter((call) => call.name === "finalize_ai_usage").length,
      1,
      "one finalize on EOF",
    );
  });
}

Deno.test("Gemini terminal: incomplete UTF-8 at EOF cannot become successful", async () => {
  const prefix = enc.encode(CONTENT + STOP + ": ");
  const input = new Uint8Array([...prefix, 0xf0, 0x9f]);
  const { res } = await handler(closed(input, 1));
  equal(
    Array.from(new Uint8Array(await res.arrayBuffer())),
    Array.from(input),
    "invalid UTF-8 bytes preserved without DONE",
  );
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

Deno.test("Gemini terminal: cancellation before usage preserves token/cost estimate", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(CONTENT));
    },
  });
  const { res, calls } = await handler(source);
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  await tick();
  const final = calls.filter((call) => call.name === "finalize_ai_usage");
  equal(final.length, 1, "exactly one finalize before vendor usage");
  const args = final[0].args;
  // Fixture prompt JSON = 34 chars; content = 11 UTF-16 chars. Ceil(chars/4).
  equal([args.p_prompt_tokens, args.p_completion_tokens, args.p_total_tokens], [
    9,
    3,
    12,
  ], "abort estimate still charges consumed tokens");
  equal(
    args.p_cost_usd,
    9 / 1e6 * 2 + 3 / 1e6 * 4,
    "estimate cost follows estimated tokens",
  );
  equal(
    args.p_status,
    "stream_aborted_estimated",
    "aborted estimate remains explicit",
  );
});

for (const ending of ["abort", "cancel", "network", "idle", "wall"] as const) {
  Deno.test(`Gemini terminal: ${ending} after stop/usage never emits DONE and finalizes once`, async () => {
    const clockCallbacks = new Map<number, () => void>();
    const realSetTimeout = globalThis.setTimeout;
    // Capture the real handler's existing clocks; no shortened production SLA.
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      if (typeof callback === "function" && (ms === 30_000 || ms === 180_000)) {
        clockCallbacks.set(ms, callback);
      }
      return realSetTimeout(callback, ms);
    }) as typeof setTimeout;
    const abort = new AbortController();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(ctrl) {
        upstream = ctrl;
        ctrl.enqueue(enc.encode(CONTENT + STOP));
      },
      cancel() {
        cancelled = true;
      },
    });
    let result: Awaited<ReturnType<typeof handler>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      result = await handler(source, { signal: abort.signal });
      reader = result.res.body!.getReader();
      const first = await reader.read();
      equal(
        new TextDecoder().decode(first.value),
        CONTENT + STOP,
        "terminal bytes arrive before EOF",
      );
      equal(
        result.calls.filter((call) => call.name === "finalize_ai_usage").length,
        0,
        "stop is not EOF",
      );
      let tail = "";
      let rejected = false;
      if (ending === "cancel") await reader.cancel("client stopped reading");
      else {
        if (ending === "network") {
          upstream.error(new Error("synthetic network failure"));
        } else if (ending === "abort") {
          abort.abort();
          // Even if a transport reports ordinary EOF after abort, it is not success.
          upstream.close();
        } else {
          const fire = clockCallbacks.get(ending === "idle" ? 30_000 : 180_000);
          if (!fire) throw new Error("handler did not register stream clock");
          fire();
        }
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            tail += new TextDecoder().decode(item.value);
          }
        } catch {
          rejected = true;
        }
      }
      await tick();
      equal(
        tail.includes("[DONE]"),
        false,
        `${ending} must not synthesize DONE`,
      );
      if (ending === "network") {
        equal(rejected, true, "network error must reach client");
      }
      usageUnchanged(result.calls);
      if (ending !== "network") {
        equal(
          result.upstreamSignal?.aborted,
          true,
          `${ending} cancels upstream`,
        );
      }
      if (ending === "cancel") {
        equal(cancelled, true, "client cancel reaches upstream body");
      }
    } finally {
      // Clean real timers even when a baseline assertion fails.
      abort.abort();
      try {
        await reader?.cancel();
      } catch { /* already errored */ }
      globalThis.setTimeout = realSetTimeout;
    }
  });
}
