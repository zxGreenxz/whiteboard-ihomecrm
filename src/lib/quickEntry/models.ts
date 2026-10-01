// Ô chọn mô hình AI trên trang "Báo chi nhanh" — chủ muốn tự thử và so sánh (01/10/2026).
// Danh sách PHẢI khớp danh sách cho phép của hàm máy chủ quick-entry (STT_CHOICES / READ_MODEL_CHOICES /
// READ_EFFORTS / READ_UNSUPPORTED) — test đọc mã máy chủ giữ hai bên khớp. Máy chủ vẫn tự kiểm: id lạ ⇒
// chuỗi mặc định, nên lựa chọn cũ/hỏng trên máy không mở được mô hình ngoài danh sách.
// Số liệu ở `hint` là số đo 01/10/2026 (chép giọng: 64 đoạn tiếng Việt sạch + ồn; đọc: câu ngắn, mức thấp).

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
}

export const STT_OPTIONS: readonly ModelOption[] = [
  { id: "google/chirp-3", label: "Google Chirp 3", hint: "đúng 64/64 · ~3 giây" },
  { id: "deepgram/nova-3", label: "Deepgram Nova 3", hint: "đúng 62/64 · ~1,4 giây" },
  { id: "openai/whisper-1", label: "OpenAI Whisper", hint: "đúng 62/64 · ~1,4 giây" },
  { id: "google/gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe", hint: "đúng 60/64 · ~4 giây" },
  { id: "openai/whisper-large-v3", label: "Whisper Large v3", hint: "đúng 59/64 · rẻ nhất" },
];

export const READ_MODELS: readonly ModelOption[] = [
  { id: "cx/gpt-6.1-sol", label: "GPT-6.1 Sol", hint: "~5,5 giây" },
  { id: "cx/gpt-6-astra", label: "GPT-6 Astra", hint: "~5,5 giây" },
  { id: "cx/gpt-6-sol", label: "GPT-6 Sol", hint: "~4,5 giây" },
  { id: "cx/gpt-6-luna", label: "GPT-6 Luna", hint: "~3,5 giây" },
  { id: "cx/gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "~4,5 giây" },
];

/** Mức suy nghĩ của 9router (hậu tố "(mức)" sau id; rỗng = tự động). */
export const READ_EFFORTS: readonly ModelOption[] = [
  { id: "", label: "Tự động", hint: "" },
  { id: "minimal", label: "Tối thiểu", hint: "nhanh nhất" },
  { id: "low", label: "Thấp", hint: "nhanh" },
  { id: "medium", label: "Vừa", hint: "" },
  { id: "high", label: "Cao", hint: "chậm hơn" },
  { id: "xhigh", label: "Rất cao", hint: "chậm" },
  { id: "max", label: "Tối đa", hint: "chậm, ~15 giây" },
  { id: "ultra", label: "Ultra", hint: "chậm nhất" },
];

/** Tổ hợp 9router từ chối (đo 01/10/2026: Astra trả 400 với minimal). */
export const READ_UNSUPPORTED: readonly string[] = ["cx/gpt-6-astra(minimal)"];

export interface ModelChoice {
  stt: string;
  readModel: string;
  effort: string;
}

export const DEFAULT_CHOICE: ModelChoice = { stt: "google/chirp-3", readModel: "cx/gpt-6-luna", effort: "low" };

export const readModelId = (c: Pick<ModelChoice, "readModel" | "effort">): string =>
  c.effort ? `${c.readModel}(${c.effort})` : c.readModel;

export const isSupported = (readModel: string, effort: string): boolean =>
  !READ_UNSUPPORTED.includes(readModelId({ readModel, effort }));

const pick = (v: unknown, list: readonly ModelOption[], fallback: string): string =>
  typeof v === "string" && list.some((o) => o.id === v) ? v : fallback;

/** Lựa chọn đã lưu (có thể cũ/hỏng) ⇒ lựa chọn hợp lệ; tổ hợp không hỗ trợ ⇒ mức mặc định, giữ mô hình. */
export function normalizeChoice(raw: unknown): ModelChoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ModelChoice, unknown>>;
  const stt = pick(r.stt, STT_OPTIONS, DEFAULT_CHOICE.stt);
  const readModel = pick(r.readModel, READ_MODELS, DEFAULT_CHOICE.readModel);
  const effort = pick(r.effort, READ_EFFORTS, DEFAULT_CHOICE.effort);
  return { stt, readModel, effort: isSupported(readModel, effort) ? effort : DEFAULT_CHOICE.effort };
}

/** Tên dễ đọc cho id mô hình máy chủ báo đã trả lời (header x-quick-entry-model); id lạ ⇒ chính id. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "";
  const bare = id.replace(/^[a-z0-9]+:/, "");
  const stt = STT_OPTIONS.find((o) => o.id === bare);
  if (stt) return stt.label;
  const m = /^([^()]+)(?:\(([a-z]+)\))?$/.exec(bare);
  const family = m ? READ_MODELS.find((o) => o.id === m[1]) : undefined;
  if (!m || !family) return id;
  const effort = READ_EFFORTS.find((o) => o.id === (m[2] ?? ""));
  return `${family.label} · ${(effort?.label ?? m[2] ?? "").toLowerCase()}`;
}

const keyOf = (userId: string) => `ihome:quick-entry:models:${userId}`;

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;

const browserStorage = (): (ReadStore & WriteStore) | null => (typeof localStorage === "undefined" ? null : localStorage);

/** Lựa chọn đã nhớ của người dùng trên máy này; không đọc được ⇒ mặc định. */
export function loadChoice(userId: string | null, storage: ReadStore | null = browserStorage()): ModelChoice {
  let raw: string | null = null;
  try {
    raw = userId && storage ? storage.getItem(keyOf(userId)) : null;
  } catch {
    // Trình duyệt chặn bộ nhớ (chế độ riêng tư…) ⇒ không nhớ được, dùng mặc định bên dưới.
  }
  let parsed: unknown = null;
  try {
    parsed = raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    // Giá trị hỏng ⇒ coi như chưa chọn; normalizeChoice trả mặc định.
  }
  return normalizeChoice(parsed);
}

/** Nhớ lựa chọn; bộ nhớ bị chặn thì thôi — lựa chọn vẫn dùng được trong phiên này. */
export function saveChoice(userId: string | null, choice: ModelChoice, storage: WriteStore | null = browserStorage()): void {
  if (!userId || !storage) return;
  try {
    storage.setItem(keyOf(userId), JSON.stringify(normalizeChoice(choice)));
  } catch {
    // Không lưu được (bộ nhớ đầy/bị chặn) — chỉ mất phần "nhớ lần sau", không ảnh hưởng lần dùng này.
  }
}
