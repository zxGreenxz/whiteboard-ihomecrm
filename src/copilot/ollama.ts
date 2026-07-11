// Ollama local (data_class 'local_only') — model KHÔNG khai báo trong DB mà
// TỰ PHÁT HIỆN từ Ollama đang chạy trên máy người dùng (localhost:11434).
// Không chạy Ollama → trả rỗng lặng lẽ (dropdown không hiện gì).
//
// LƯU Ý cho user chạy Ollama với web HTTPS (ptcrm.vercel.app):
// - Chrome cho phép trang HTTPS gọi http://localhost (miễn trừ mixed-content).
// - Ollama mặc định CHẶN cross-origin → phải chạy với OLLAMA_ORIGINS:
//     Windows:  setx OLLAMA_ORIGINS "*"  (rồi khởi động lại Ollama)
//     macOS/Linux: OLLAMA_ORIGINS="*" ollama serve
export const OLLAMA_ROOT = 'http://localhost:11434';

export interface OllamaModelOption {
  id: string;    // vd "qwen3:8b"
  label: string;
}

export async function listOllamaModels(timeoutMs = 1500): Promise<OllamaModelOption[]> {
  try {
    const res = await fetch(`${OLLAMA_ROOT}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? [])
      .filter((m) => !!m?.name)
      .map((m) => ({ id: m.name, label: m.name }));
  } catch {
    return []; // không chạy Ollama / timeout / CORS — coi như không có
  }
}
