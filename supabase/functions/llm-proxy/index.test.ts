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
};

const proxyModule = import("./index.ts").catch(() => null);

async function nap(): Promise<ProxyModule> {
  const loaded = await proxyModule;
  assert(loaded !== null, "llm-proxy/index.ts phải nạp được (kiểm mạng tới esm.sh nếu đỏ ở đây)");
  const m = loaded as unknown as ProxyModule;
  for (const ten of ["chonTruongBodyHopLe", "kiemKichThuocBody", "tinhEstCost", "clampMockCost"]) {
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

Deno.test("đồng hồ IM LẶNG bắn khi stream đứng hình", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 5_000, 20);
  await nghi(80);
  dongHo.don();
  assertEquals(banRa, ["im"], "không có chunk nào trong 20ms ⇒ hết hạn im lặng");
});

Deno.test("mỗi chunk dời hạn im lặng, nhưng KHÔNG dời hạn tổng", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 120, 40);
  // 8 nhịp × 20ms = 160ms: vượt hẳn hạn tổng 120ms để phép thử không phụ thuộc
  // vào việc setTimeout trả sớm hay muộn vài mili giây.
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
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 30, 15);
  dongHo.don();
  await nghi(80);
  assertEquals(banRa, [], "stream đóng đẹp rồi thì đồng hồ phải câm");
});

Deno.test("đồng hồ chỉ bắn ĐÚNG MỘT lần", async () => {
  const { taoDongHoStream } = await nap();
  const banRa: string[] = [];
  const dongHo = taoDongHoStream((lyDo) => banRa.push(lyDo), 25, 15);
  await nghi(120);
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
