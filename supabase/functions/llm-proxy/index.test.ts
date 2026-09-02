// Test cho các hàm THUẦN của llm-proxy — cửa vào của proxy, nơi bốn lỗ G0-A đã
// nằm: mock bật sẵn, body forward nguyên si, không trần kích thước, stream không
// đồng hồ.
//
// Vì sao test ở đây mà không phải qua HTTP: mọi thứ đáng kiểm trong đợt này là
// QUYẾT ĐỊNH — bỏ khoá nào, chặn ở ngưỡng nào, đồng hồ nào bắn trước — chứ không
// phải đường dây mạng. Đưa chúng ra hàm thuần rồi gọi thẳng thì test không cần
// upstream giả, không cần JWT, và đỏ ở đúng dòng sai.
//
//   deno test --config supabase/functions/llm-proxy/deno.json \
//     supabase/functions/llm-proxy/index.test.ts --allow-env
//
// Khuôn theo supabase/functions/network-center-worker/index.test.ts: tự viết
// assert thay vì kéo std, và nạp module bằng dynamic import để lỗi nạp hiện ra
// thành một thông báo đọc được chứ không phải stack trace của runtime.

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = "Values differ"): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}\nactual: ${actualJson}\nexpected: ${expectedJson}`);
  }
}

interface ModelPricing {
  pricing_mode: "metered" | "free" | "self_hosted";
  input_price: number;
  output_price: number;
}

interface LoiKichThuoc {
  status: number;
  message: string;
  code: string;
}

interface DongHoStream {
  datLai(): void;
  don(): void;
}

type ProxyModule = {
  ALLOWED_HEADERS: string;
  TRUONG_BODY_HOP_LE: readonly string[];
  GIOI_HAN_BODY_BYTES: number;
  GIOI_HAN_SO_MESSAGE: number;
  GIOI_HAN_SO_ANH: number;
  TRAN_PARSE_DONG_THOI: number;
  chonTruongBodyHopLe: (body: Record<string, unknown>) => Record<string, unknown>;
  kiemKichThuocBody: (text: string, messages: unknown) => LoiKichThuoc | null;
  tinhEstCost: (pricing: ModelPricing, promptChars: number, maxOut: number) => number;
  clampMockCost: (header: string | null, estCost: number) => number;
  mockDuocPhep: (getEnv?: (key: string) => string | undefined) => boolean;
  taoDongHoStream: (
    khiHetGio: (lyDo: "tong" | "im") => void,
    tongMs?: number,
    imMs?: number,
  ) => DongHoStream;
  docBodyCoTran: (
    body: ReadableStream<Uint8Array> | null,
    gioiHanBytes: number,
  ) => Promise<{ ok: true; text: string } | { ok: false }>;
  dangParseHienTai: () => number;
  docOrganizationId: (headers: Headers) => string | null;
  xuLyYeuCau: (req: Request, deps?: PhuThuocGia) => Promise<Response>;
};

/**
 * Bề mặt handler đi mượn. Khai lại ở đây thay vì import type từ index.ts để test
 * ĐỎ khi index.ts đổi hình dạng — import type sẽ tự trôi theo và im lặng.
 */
interface PhuThuocGia {
  admin?: unknown;
  getEnv?: (key: string) => string | undefined;
  fetchImpl?: typeof fetch;
}

const proxyModule = import("./index.ts").catch(() => null);

async function nap(): Promise<ProxyModule> {
  const loaded = await proxyModule;
  assert(loaded !== null, "llm-proxy/index.ts phải nạp được (kiểm mạng tới esm.sh nếu đỏ ở đây)");
  const m = loaded as unknown as ProxyModule;
  for (
    const ten of [
      "chonTruongBodyHopLe",
      "kiemKichThuocBody",
      "tinhEstCost",
      "clampMockCost",
      "docOrganizationId",
    ]
  ) {
    assertEquals(
      typeof (m as unknown as Record<string, unknown>)[ten],
      "function",
      `index.ts phải export ${ten}`,
    );
  }
  return m;
}

const nghi = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 1. Allowlist body ──────────────────────────────────────────────────────

Deno.test("chonTruongBodyHopLe bỏ mọi khoá lái model/định tuyến của upstream", async () => {
  const { chonTruongBodyHopLe } = await nap();
  const ra = chonTruongBodyHopLe({
    messages: [{ role: "user", content: "chào" }],
    // Nhóm này của OpenRouter đổi HẲN model chạy thật, vòng qua bảng giá đã duyệt.
    models: ["anthropic/claude-opus-4"],
    provider: { order: ["Anthropic"] },
    route: "fallback",
    transforms: ["middle-out"],
    plugins: [{ id: "web" }],
    reasoning: { effort: "high" },
    max_completion_tokens: 100000,
    n: 8,
    user: "ai-do",
    model: "mock:done",
  });
  assertEquals(Object.keys(ra).sort(), ["messages"], "chỉ `messages` được đi tiếp");
});

Deno.test("chonTruongBodyHopLe giữ nguyên các khoá hợp lệ, kể cả tools", async () => {
  const { chonTruongBodyHopLe, TRUONG_BODY_HOP_LE } = await nap();
  const vao = {
    messages: [{ role: "user", content: "x" }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 512,
    temperature: 0.2,
    top_p: 0.9,
    tools: [{ type: "function", function: { name: "AgentOutput" } }],
    tool_choice: "required",
    response_format: { type: "json_object" },
  };
  const ra = chonTruongBodyHopLe(vao);
  assertEquals(Object.keys(ra).sort(), Object.keys(vao).sort(), "9 khoá hợp lệ phải qua đủ");
  assertEquals(ra.tools, vao.tools, "tools là đường tool-calling của Copilot — không được rơi");
  assertEquals([...TRUONG_BODY_HOP_LE].sort(), Object.keys(vao).sort());
});

// ── 2. Trần kích thước ─────────────────────────────────────────────────────

Deno.test("body vượt 512 KiB bị chặn 413 body_too_large", async () => {
  const { kiemKichThuocBody, GIOI_HAN_BODY_BYTES } = await nap();
  assertEquals(GIOI_HAN_BODY_BYTES, 524288);
  const vua = "a".repeat(GIOI_HAN_BODY_BYTES);
  assertEquals(kiemKichThuocBody(vua, []), null, "đúng bằng trần thì vẫn qua");
  const qua = "a".repeat(GIOI_HAN_BODY_BYTES + 1);
  assertEquals(kiemKichThuocBody(qua, []), {
    status: 413,
    message: "Request body too large",
    code: "body_too_large",
  });
});

Deno.test("trần đo theo BYTE UTF-8, không theo ký tự", async () => {
  const { kiemKichThuocBody, GIOI_HAN_BODY_BYTES } = await nap();
  // "đ" là 2 byte: nửa trần ký tự đã chạm trọn trần byte.
  const text = "đ".repeat(GIOI_HAN_BODY_BYTES / 2 + 1);
  assert(text.length < GIOI_HAN_BODY_BYTES, "phép thử chỉ có nghĩa khi số KÝ TỰ còn dưới trần");
  assertEquals(kiemKichThuocBody(text, [])?.code, "body_too_large");
});

Deno.test("quá 64 message bị chặn 400 too_many_messages", async () => {
  const { kiemKichThuocBody, GIOI_HAN_SO_MESSAGE } = await nap();
  assertEquals(GIOI_HAN_SO_MESSAGE, 64);
  const mot = { role: "user", content: "x" };
  assertEquals(kiemKichThuocBody("{}", new Array(GIOI_HAN_SO_MESSAGE).fill(mot)), null);
  const loi = kiemKichThuocBody("{}", new Array(GIOI_HAN_SO_MESSAGE + 1).fill(mot));
  assertEquals(loi?.status, 400);
  assertEquals(loi?.code, "too_many_messages");
});

Deno.test("quá 4 ảnh bị chặn 400 too_many_images", async () => {
  const { kiemKichThuocBody, GIOI_HAN_SO_ANH } = await nap();
  const anh = (i: number) => ({ type: "image_url", image_url: { url: `https://x/${i}.png` } });
  const dung = [{ role: "user", content: [0, 1, 2, 3].map(anh) }];
  assertEquals(kiemKichThuocBody("{}", dung), null, `${GIOI_HAN_SO_ANH} ảnh vẫn qua`);
  const thua = [{ role: "user", content: [0, 1, 2].map(anh) }, { role: "user", content: [3, 4].map(anh) }];
  const loi = kiemKichThuocBody("{}", thua);
  assertEquals(loi?.status, 400);
  assertEquals(loi?.code, "too_many_images");
});

Deno.test("tổng base64 ảnh vượt 6 MB bị chặn dù ĐẾM ảnh còn trong ngưỡng", async () => {
  const { kiemKichThuocBody } = await nap();
  // Text truyền vào nhỏ, để phép thử soi ĐÚNG luật ảnh chứ không phải trần body.
  // Qua HTTP thật thì trần 512 KiB chặn trước — luật này là lớp thứ hai, sống
  // để trần body nới ra sau vẫn còn hàng rào.
  const to = `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}`;
  const messages = [{ role: "user", content: [
    { type: "image_url", image_url: { url: to } },
    { type: "image_url", image_url: { url: to } },
  ] }];
  assertEquals(kiemKichThuocBody("{}", messages)?.code, "too_many_images");
});

Deno.test("body bình thường không bị chặn gì", async () => {
  const { kiemKichThuocBody } = await nap();
  const messages = [
    { role: "system", content: "Bạn là trợ lý." },
    { role: "user", content: [{ type: "text", text: "xin chào" }] },
  ];
  assertEquals(kiemKichThuocBody(JSON.stringify({ messages }), messages), null);
});

// ── 3. Mock: công tắc và chi phí ép ────────────────────────────────────────

Deno.test("mock chỉ chạy khi LLM_PROXY_ALLOW_MOCK = '1'", async () => {
  const { mockDuocPhep } = await nap();
  const env = (giaTri: string | undefined) => () => giaTri;
  assertEquals(mockDuocPhep(env(undefined)), false, "thiếu env ⇒ chặn");
  assertEquals(mockDuocPhep(env("")), false);
  assertEquals(mockDuocPhep(env("0")), false);
  assertEquals(mockDuocPhep(env("true")), false, "chỉ đúng chuỗi '1' mới mở");
  assertEquals(mockDuocPhep(env("1")), true);
});

Deno.test("x-mock-cost âm bị clamp về 0, rác/vô cực giữ nguyên dự toán", async () => {
  const { clampMockCost } = await nap();
  // Bản cũ nhận thẳng số âm ⇒ finalize ghi -5 USD ⇒ hạn mức ngày được HOÀN.
  assertEquals(clampMockCost("-5", 0.01), 0);
  assertEquals(clampMockCost("-0.000001", 0.01), 0);
  assertEquals(clampMockCost("0.25", 0.01), 0.25);
  assertEquals(clampMockCost("0", 0.01), 0);
  assertEquals(clampMockCost(null, 0.01), 0.01, "không gửi header ⇒ giữ dự toán");
  assertEquals(clampMockCost("khong-phai-so", 0.01), 0.01);
  assertEquals(clampMockCost("Infinity", 0.01), 0.01, "vô cực không phải một mức giá");
  assertEquals(clampMockCost("-Infinity", 0.01), 0.01);
});

// ── 4. Ước lượng chi phí ───────────────────────────────────────────────────

Deno.test("tinhEstCost đúng công thức prompt chars/4 và max_tokens", async () => {
  const { tinhEstCost } = await nap();
  const pricing: ModelPricing = { pricing_mode: "metered", input_price: 3, output_price: 15 };
  // 4000 ký tự ⇒ 1000 token vào × 3 USD/1M + 500 token ra × 15 USD/1M
  const mong = (1000 / 1e6) * 3 + (500 / 1e6) * 15;
  assertEquals(tinhEstCost(pricing, 4000, 500), mong);
  assertEquals(tinhEstCost({ pricing_mode: "free", input_price: 0, output_price: 0 }, 4000, 500), 0);
});

// ── 5. Đồng hồ stream ──────────────────────────────────────────────────────
//
// LUẬT BIÊN CHO MỌI TEST ĐỒNG HỒ Ở MỤC NÀY: khoảng chờ phải ≥ 5× cái ngòi mà nó
// đang đợi, và cái ngòi KHÔNG được phép bắn phải ≥ 5× nhịp gõ. Lý do là hạt của
// `setTimeout` trên máy CI không mịn — một nhịp 20ms có thể thành 60ms khi runner
// đang kẹt, và một biên 2× sẽ đỏ ngẫu nhiên. Test đỏ ngẫu nhiên là test bị tắt.
// Giá phải trả cho biên rộng chỉ là vài trăm mili-giây cho cả mục.

Deno.test("đồng hồ IM LẶNG bắn khi stream đứng hình", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  // Ngòi im lặng 20ms; chờ 150ms = 7,5× (biên đợi). Hạn tổng 5s ở xa hẳn nên
  // không có cách nào nó cướp lượt bắn của hạn im lặng.
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 5_000, 20);
  await nghi(150);
  dongHo.don();
  assertEquals(banRa, ["im"], "không có chunk nào trong 20ms ⇒ hết hạn im lặng");
});

Deno.test("mỗi chunk dời hạn im lặng, nhưng KHÔNG dời hạn tổng", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 120, 200);
  // 8 nhịp × 20ms = 160ms: vượt hẳn hạn tổng 120ms. Hạn im lặng để 200ms = 10×
  // nhịp gõ — đúng luật biên ở đầu mục, nên máy CI kẹt một nhịp cũng không bắn
  // nhầm "im". Máy chạy CHẬM chỉ làm hạn tổng chín sớm hơn so với vòng lặp, tức
  // đẩy kết quả về phía khẳng định, không về phía đỏ ngẫu nhiên.
  for (let i = 0; i < 8; i += 1) {
    await nghi(20);
    dongHo.datLai(); // stream vẫn chảy đều
  }
  dongHo.don();
  assertEquals(banRa, ["tong"], "chunk đều đặn cứu được hạn im lặng, không cứu được hạn tổng");
});

Deno.test("don() gỡ sạch đồng hồ — không bắn sau khi stream đã đóng", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  // Ngòi 30ms/15ms, chờ 200ms = 6,7× ngòi dài nhất: nếu `don()` sót một đồng hồ
  // thì trong 200ms nó chắc chắn đã bắn. Chờ ngắn hơn thì "không thấy bắn" có
  // thể chỉ nghĩa là chưa kịp bắn — một phép đo không chứng minh được điều gì.
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 30, 15);
  dongHo.don();
  await nghi(200);
  assertEquals(banRa, [], "stream đóng đẹp rồi thì đồng hồ phải câm");
});

Deno.test("đồng hồ chỉ bắn ĐÚNG MỘT lần", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  // Hai ngòi 25ms/15ms cùng chín trong khoảng chờ 200ms (8× ngòi dài nhất). Chờ
  // đủ rộng mới đo được ĐÚNG thứ cần đo: không phải "cái thứ hai chưa tới giờ"
  // mà là "cái thứ hai đã bị `daBan` chặn".
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 25, 15);
  await nghi(200);
  dongHo.don();
  assertEquals(banRa.length, 1, "hai lần bắn = hai lần finalize = ghi đè sổ usage");
});

// ── 6. CORS: chỗ dành sẵn cho G0-B ─────────────────────────────────────────

Deno.test("CORS cho phép x-organization-id (G0-B) và giữ nguyên các header cũ", async () => {
  const { ALLOWED_HEADERS } = await nap();
  for (const h of [
    "authorization",
    "x-client-info",
    "apikey",
    "content-type",
    "x-copilot-feature",
    "x-task-id",
    "x-mock-step",
    "x-mock-cost",
    "x-organization-id",
  ]) {
    assert(ALLOWED_HEADERS.split(", ").includes(h), `CORS thiếu header ${h}`);
  }
});

Deno.test("trần parse đồng thời là 8", async () => {
  const { TRAN_PARSE_DONG_THOI } = await nap();
  assertEquals(TRAN_PARSE_DONG_THOI, 8);
});

// ── 7. Đọc body có trần THẬT (không phải trần đo sau khi đã nạp hết) ───────

/** Nguồn đếm số chunk đã bơm ra. `highWaterMark: 0` để stream KHÔNG kéo trước. */
function nguonDem(chunks: Uint8Array[]): { luong: ReadableStream<Uint8Array>; daBom: () => number } {
  let i = 0;
  const luong = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i >= chunks.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(chunks[i]);
      i += 1;
    },
  }, new CountQueuingStrategy({ highWaterMark: 0 }));
  return { luong, daBom: () => i };
}

Deno.test("docBodyCoTran: tổng ĐÚNG BẰNG trần thì qua, và ghép lại đủ byte", async () => {
  const { docBodyCoTran } = await nap();
  const chunks = [0, 1, 2, 3, 4].map(() => new TextEncoder().encode("a".repeat(50)));
  const { luong } = nguonDem(chunks);
  const kq = await docBodyCoTran(luong, 250);
  assert(kq.ok, "250 byte trên trần 250 phải qua");
  assertEquals(kq.ok ? kq.text.length : -1, 250);
});

Deno.test("docBodyCoTran: vượt trần thì DỪNG NGAY, không kéo nốt phần còn lại", async () => {
  const { docBodyCoTran } = await nap();
  // 10 chunk × 100 byte = 1000 byte, trần 250 ⇒ chunk thứ 3 làm tổng thành 300.
  const chunks = new Array(10).fill(0).map(() => new TextEncoder().encode("b".repeat(100)));
  const { luong, daBom } = nguonDem(chunks);
  const kq = await docBodyCoTran(luong, 250);
  assertEquals(kq.ok, false);
  // Đây mới là điều phải chứng minh: bộ nhớ dừng ở trần, không ở kích thước body.
  // Với highWaterMark 0 con số đúng là 3; nới tới 4 để không phụ thuộc vào việc
  // một bản runtime có kéo trước một chunk hay không.
  assert(daBom() <= 4, `đã kéo ${daBom()}/10 chunk — trần không chặn được gì`);
  assert(daBom() < chunks.length, "không được kéo hết body rồi mới báo quá trần");
});

Deno.test("docBodyCoTran: ký tự nhiều byte bị cắt ngang biên chunk vẫn ghép đúng", async () => {
  const { docBodyCoTran } = await nap();
  const goc = "Điện nước tháng 9 — phòng 302 · 1.250.000₫";
  const byte = new TextEncoder().encode(goc);
  // Cắt mỗi 3 byte, nên có ký tự bị xẻ đôi giữa hai chunk.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < byte.length; i += 3) chunks.push(byte.slice(i, i + 3));
  const { luong } = nguonDem(chunks);
  const kq = await docBodyCoTran(luong, 1024);
  assert(kq.ok, "body nhỏ phải qua");
  assertEquals(kq.ok ? kq.text : "", goc, "TextDecoder phải chạy ở chế độ stream");
  assert(!(kq.ok && kq.text.includes("�")), "không được sinh ký tự thay thế");
});

Deno.test("docBodyCoTran: body null (không có thân) trả chuỗi rỗng", async () => {
  const { docBodyCoTran } = await nap();
  const kq = await docBodyCoTran(null, 10);
  assert(kq.ok);
  assertEquals(kq.ok ? kq.text : "x", "");
});

// ── 8. Handler: cổng mock, finalize một lần, semaphore ─────────────────────

type GoiRpc = { ten: string; args: Record<string, unknown> };

/** Client admin giả: ghi lại mọi lượt gọi RPC để đếm. */
function adminGia(options?: {
  provider?: { provider: string; enabled: boolean; models: unknown; data_class: string } | null;
  reserveLoi?: string;
}) {
  const goi: GoiRpc[] = [];
  const dong = options?.provider === undefined
    ? { provider: "mock", enabled: true, models: [], data_class: "cloud" }
    : options.provider;
  const admin = {
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({
          data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
          error: null,
        }),
    },
    from: (_bang: string) => ({
      select: (_cot: string) => ({
        eq: (_c: string, _v: string) => ({
          maybeSingle: () => Promise.resolve({ data: dong, error: null }),
        }),
      }),
    }),
    rpc: (ten: string, args: Record<string, unknown>) => {
      goi.push({ ten, args });
      if (ten === "reserve_ai_usage" && options?.reserveLoi) {
        return Promise.resolve({ data: null, error: { message: options.reserveLoi } });
      }
      if (ten === "reserve_ai_usage") {
        return Promise.resolve({ data: "22222222-2222-4222-8222-222222222222", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  const dem = (ten: string) => goi.filter((g) => g.ten === ten).length;
  return { admin, goi, dem };
}

const URL_CHAT = "https://proxy.test/functions/v1/llm-proxy/chat/completions";

/** Công ty giả cho các ca không nói về tổ chức — proxy nay ĐÒI header này. */
const ORG_GIA = "33333333-3333-4333-8333-333333333333";

// `x-organization-id` nằm trong mặc định, và ca nào muốn thiếu nó thì truyền
// `{ "x-organization-id": "" }` — Headers bỏ qua giá trị rỗng khi đọc lại nên
// không cần một cửa hậu riêng cho việc "gỡ header".
function yeuCau(body: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = {
    Authorization: "Bearer jwt-gia",
    "Content-Type": "application/json",
    "x-organization-id": ORG_GIA,
    ...headers,
  };
  for (const [k, v] of Object.entries(h)) if (v === "") delete h[k];
  return new Request(URL_CHAT, { method: "POST", headers: h, body: JSON.stringify(body) });
}

Deno.test("(a) thiếu LLM_PROXY_ALLOW_MOCK: 403 và KHÔNG hề reserve", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, dem } = adminGia();
  const res = await xuLyYeuCau(
    yeuCau({ model: "mock:done", messages: [{ role: "user", content: "chào" }] }),
    { admin, getEnv: () => undefined },
  );
  assertEquals(res.status, 403);
  const than = await res.json();
  assertEquals(than.error.code, "provider_disabled");
  // Cổng phải đứng TRƯỚC reserve: nếu sau, mỗi lần thử là một dòng usage rác và
  // một suất hạn mức bị giữ.
  assertEquals(dem("reserve_ai_usage"), 0, "đã reserve rồi mới chặn — sai thứ tự");
  assertEquals(dem("finalize_ai_usage"), 0);
});

Deno.test("(b) mock được phép: finalize ĐÚNG MỘT lần cho một lượt gọi", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, dem, goi } = adminGia();
  const res = await xuLyYeuCau(
    yeuCau({ model: "mock:done", messages: [{ role: "user", content: "chào" }] }),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  assertEquals(res.status, 200);
  await res.json();
  assertEquals(dem("reserve_ai_usage"), 1);
  assertEquals(dem("finalize_ai_usage"), 1, "hai lần finalize là ghi đè sổ usage");
  const chot = goi.find((g) => g.ten === "finalize_ai_usage");
  assertEquals(chot?.args.p_status, "ok");
});

Deno.test("(b2) x-mock-cost âm: reserve nhận 0, không nhận số âm", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, goi } = adminGia();
  await xuLyYeuCau(
    yeuCau(
      { model: "mock:done", messages: [{ role: "user", content: "x" }] },
      { "x-mock-cost": "-5" },
    ),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  const dat = goi.find((g) => g.ten === "reserve_ai_usage");
  assertEquals(dat?.args.p_est_cost_usd, 0, "số âm ở đây HOÀN LẠI hạn mức ngày");
});

Deno.test("(c) luồng body lỗi: trả 400 và NHẢ semaphore", async () => {
  const { xuLyYeuCau, dangParseHienTai } = await nap();
  const { admin } = adminGia();
  assertEquals(dangParseHienTai(), 0, "phép thử chỉ có nghĩa khi bắt đầu từ 0");
  const luongLoi = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.error(new Error("mang dut giua chung"));
    },
  });
  const init: RequestInit & { duplex?: string } = {
    method: "POST",
    headers: { Authorization: "Bearer jwt-gia", "Content-Type": "application/json" },
    body: luongLoi,
    duplex: "half",
  };
  const res = await xuLyYeuCau(new Request(URL_CHAT, init), { admin, getEnv: () => undefined });
  assertEquals(res.status, 400);
  await res.body?.cancel();
  // Không nhả thì sau 8 request hỏng, proxy trả 429 cho mọi người, vĩnh viễn.
  assertEquals(dangParseHienTai(), 0, "semaphore rò — đường lỗi không đi qua finally");
});

Deno.test("(d) upstream ném: finalize đúng MỘT lần với trạng thái lỗi", async () => {
  const { xuLyYeuCau, dangParseHienTai } = await nap();
  const { admin, dem, goi } = adminGia({
    provider: {
      provider: "openrouter",
      enabled: true,
      models: [{ id: "m1", pricing_mode: "free", input_price: 0, output_price: 0 }],
      data_class: "cloud",
    },
  });
  const res = await xuLyYeuCau(
    yeuCau({ model: "openrouter:m1", messages: [{ role: "user", content: "x" }] }),
    {
      admin,
      getEnv: (k) => (k === "OPENROUTER_API_KEY" ? "key-gia" : undefined),
      fetchImpl: () => Promise.reject(new Error("upstream sap")),
    },
  );
  assertEquals(res.status, 502);
  await res.json();
  assertEquals(dem("reserve_ai_usage"), 1);
  // Cả `catch` lẫn lưới `finally` đều muốn chốt sổ — guard daFinalize phải chặn
  // lần thứ hai, nếu không dòng usage bị ghi đè.
  assertEquals(dem("finalize_ai_usage"), 1);
  const chot = goi.find((g) => g.ten === "finalize_ai_usage");
  assertEquals(chot?.args.p_status, "upstream_error");
  assertEquals(dangParseHienTai(), 0);
});

Deno.test("(e) body vượt trần đi qua HANDLER: 413, không reserve, semaphore sạch", async () => {
  const { xuLyYeuCau, dangParseHienTai } = await nap();
  const { admin, dem } = adminGia();
  const to = { model: "mock:done", messages: [{ role: "user", content: "x".repeat(600_000) }] };
  const res = await xuLyYeuCau(yeuCau(to), { admin, getEnv: () => "1" });
  assertEquals(res.status, 413);
  const than = await res.json();
  assertEquals(than.error.code, "body_too_large");
  assertEquals(dem("reserve_ai_usage"), 0);
  assertEquals(dangParseHienTai(), 0);
});

// ── 9. Tổ chức: header x-organization-id → p_organization_id ───────────────
//
// `reserve_ai_usage` nay ĐÒI công ty (migration
// `20260902132418_copilot_reserve_ai_usage_organization_v1`). Trước đó proxy để
// trống `organization_id` và trigger `autofill_org_strict` phải SUY từ
// `user_id`: đúng khi người dùng thuộc một công ty, và sai — hoặc chết 500 —
// đúng vào kịch bản mà ô chọn công ty của Copilot sinh ra.

Deno.test("docOrganizationId: uuid hợp lệ thì trả về, rác/thiếu thì null", async () => {
  const { docOrganizationId } = await nap();
  const h = (v?: string) => new Headers(v === undefined ? {} : { "x-organization-id": v });

  assertEquals(
    docOrganizationId(h("11111111-2222-4333-8444-555555555555")),
    "11111111-2222-4333-8444-555555555555",
  );
  // Hoa/thường và khoảng trắng thừa là chuyện của bàn phím, không phải của quyền.
  assertEquals(
    docOrganizationId(h("  11111111-2222-4333-8444-555555555555  ")),
    "11111111-2222-4333-8444-555555555555",
  );
  assertEquals(
    docOrganizationId(h("11111111-2222-4333-8444-AAAAAAAAAAAA")),
    "11111111-2222-4333-8444-aaaaaaaaaaaa",
  );

  assertEquals(docOrganizationId(h()), null, "thiếu header");
  assertEquals(docOrganizationId(h("")), null, "header rỗng");
  assertEquals(docOrganizationId(h("khong-phai-uuid")), null);
  assertEquals(docOrganizationId(h("11111111-2222-4333-8444-55555555555")), null, "thiếu 1 ký tự");
  // Chặn ở đây chứ không để DB chặn: một chuỗi lạ đi tiếp là một thông báo lỗi
  // của Postgres lọt ra ngoài, và nó nói về kiểu dữ liệu chứ không về tổ chức.
  assertEquals(docOrganizationId(h("' OR 1=1 --")), null);
});

Deno.test("(f) thiếu x-organization-id: 400 organization_required, KHÔNG reserve", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, dem } = adminGia();
  const res = await xuLyYeuCau(
    yeuCau(
      { model: "mock:done", messages: [{ role: "user", content: "chào" }] },
      { "x-organization-id": "" },
    ),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  assertEquals(res.status, 400);
  const than = await res.json();
  assertEquals(than.error.code, "organization_required");
  // Phải chặn TRƯỚC reserve: reserve rồi mới biết thiếu org nghĩa là một dòng
  // pending giữ hạn mức 5 phút cho một request không bao giờ chạy.
  assertEquals(dem("reserve_ai_usage"), 0, "đã reserve rồi mới chặn — sai thứ tự");
  assertEquals(dem("finalize_ai_usage"), 0);
});

Deno.test("(f2) x-organization-id rác cũng là 400, không đẩy chuỗi lạ xuống DB", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, dem } = adminGia();
  const res = await xuLyYeuCau(
    yeuCau(
      { model: "mock:done", messages: [{ role: "user", content: "chào" }] },
      { "x-organization-id": "khong-phai-uuid" },
    ),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "organization_required");
  assertEquals(dem("reserve_ai_usage"), 0);
});

Deno.test("(g) org hợp lệ: reserve_ai_usage nhận p_organization_id", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, goi } = adminGia();
  const res = await xuLyYeuCau(
    yeuCau({ model: "mock:done", messages: [{ role: "user", content: "chào" }] }),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  assertEquals(res.status, 200);
  await res.json();
  const dat = goi.find((g) => g.ten === "reserve_ai_usage");
  assertEquals(dat?.args.p_organization_id, ORG_GIA);
});

Deno.test("(h) organization_forbidden từ RPC → 403, không phải 500", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin, dem } = adminGia({
    reserveLoi: 'organization_forbidden',
  });
  const res = await xuLyYeuCau(
    yeuCau({ model: "mock:done", messages: [{ role: "user", content: "chào" }] }),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  // 403 chứ không 500: người dùng chọn nhầm công ty là chuyện của họ sửa được,
  // còn 500 nói rằng server hỏng và LLM class sẽ retry một việc không bao giờ qua.
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error.code, "organization_forbidden");
  assertEquals(dem("finalize_ai_usage"), 0, "reserve hỏng thì chưa có gì để chốt");
});

Deno.test("(h2) organization_required từ RPC → 400 (hàng rào thứ hai)", async () => {
  const { xuLyYeuCau } = await nap();
  const { admin } = adminGia({ reserveLoi: 'organization_required' });
  const res = await xuLyYeuCau(
    yeuCau({ model: "mock:done", messages: [{ role: "user", content: "chào" }] }),
    { admin, getEnv: (k) => (k === "LLM_PROXY_ALLOW_MOCK" ? "1" : undefined) },
  );
  // Proxy đã chặn ở cửa, nhưng RPC là nơi duy nhất biết chắc — proxy có thể được
  // deploy lại từ một bản cũ hơn migration.
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "organization_required");
});
