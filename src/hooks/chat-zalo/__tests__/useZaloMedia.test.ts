// @vitest-environment jsdom
// Gửi ảnh Zalo: worker tải ĐÚNG `path` trong job (worker/lib/media.js). `uploadFile`
// nén ảnh và đổi đuôi key (.webp trên Chrome, .jpg trên Safari từ 30/09/2026) —
// job mang key cũ thì worker báo "Không tải được media từ storage". Job phải mang
// đường dẫn, định dạng và cỡ của file THẬT nằm trong kho.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

const mock = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mock.rpc } }));
vi.mock("@/lib/storage", () => ({
  uploadFileDetailed: mock.upload,
  sanitizeStorageFileName: (n: string) => n.replace(/[^\w.-]+/g, "_"),
}));
vi.mock("@/hooks/useZaloChat", () => ({
  QK: { messages: (id: string) => ["zalo-messages", id], conversations: ["zalo-conversations"] },
  mapMsg: (m: unknown) => m,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
import { useSendZaloMedia } from "../useZaloMedia";

afterEach(cleanup);

describe("useSendZaloMedia", () => {
  it("job mang đường dẫn, định dạng, cỡ và tên của file THẬT sau khi nén đổi đuôi", async () => {
    mock.upload.mockImplementation(async (bucket: string, key: string) => {
      const path = key.replace(/\.[^./]+$/, "") + ".jpg";
      return { url: `stored:${bucket}/${path}`, path, type: "image/jpeg", size: 240_000 };
    });
    mock.rpc.mockResolvedValue({ data: [{ id: "queued-message-1" }], error: null });
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useSendZaloMedia(), { wrapper });
    const photo = new File([new Uint8Array(2_900_000)], "IMG_1234.jpeg", { type: "image/jpeg" });
    result.current.mutate({ conversationId: "c", accountId: "a", kind: "image", attachments: [{ file: photo }] });
    await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1));
    const media = mock.rpc.mock.calls[0][1].p_media as Array<Record<string, unknown>>;
    const [uploadedBucket, uploadedKey] = mock.upload.mock.calls[0] as [string, string];
    expect(uploadedBucket).toBe("zalo-media");
    expect(media[0].path).toBe(uploadedKey.replace(/\.jpeg$/, ".jpg"));
    expect(media[0].url).toBe(`stored:zalo-media/${media[0].path}`);
    expect(media[0].mime).toBe("image/jpeg");
    expect(media[0].size).toBe(240_000);
    expect(media[0].filename).toBe("IMG_1234.jpg");
  });
});
