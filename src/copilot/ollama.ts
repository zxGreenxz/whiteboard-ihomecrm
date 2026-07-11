// Provider LOCAL (data_class 'local_only') — model KHÔNG khai báo trong DB mà
// TỰ PHÁT HIỆN từ instance chạy trên máy người dùng:
//   - Ollama:  localhost:11434 (GET /api/tags)
//   - 9Router: localhost:20128 (GET /v1/models — OpenAI-compatible, CORS * sẵn)
// Không chạy → trả rỗng lặng lẽ (dropdown không hiện gì).
//
// LƯU Ý cho Ollama với web HTTPS (ptcrm.vercel.app):
// - Chrome cho phép trang HTTPS gọi http://localhost (miễn trừ mixed-content).
// - Ollama mặc định CHẶN cross-origin → chạy với OLLAMA_ORIGINS:
//     Windows:  setx OLLAMA_ORIGINS "*"  (rồi khởi động lại Ollama)
//     macOS/Linux: OLLAMA_ORIGINS="*" ollama serve
//   (9Router thì mở CORS * sẵn, không cần cấu hình.)

export interface LocalModelOption {
  id: string;    // vd "qwen3:8b" / "cx/gpt-5.4-mini"
  label: string;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // không chạy / timeout / CORS — coi như không có
  }
}

export async function listOllamaModels(timeoutMs = 1500): Promise<LocalModelOption[]> {
  const data = (await fetchJson('http://localhost:11434/api/tags', timeoutMs)) as
    | { models?: { name: string }[] }
    | null;
  return (data?.models ?? [])
    .filter((m) => !!m?.name)
    .map((m) => ({ id: m.name, label: m.name }));
}

export async function list9RouterModels(timeoutMs = 1500): Promise<LocalModelOption[]> {
  const data = (await fetchJson('http://localhost:20128/v1/models', timeoutMs)) as
    | { data?: { id: string }[] }
    | null;
  return (data?.data ?? [])
    .filter((m) => !!m?.id)
    .map((m) => ({ id: m.id, label: m.id }));
}

/** Phát hiện model theo provider local. Provider lạ → rỗng. */
export async function listLocalModels(provider: string): Promise<LocalModelOption[]> {
  if (provider === 'ollama') return listOllamaModels();
  if (provider === '9router') return list9RouterModels();
  return [];
}
