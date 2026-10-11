// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ZaloConversation } from '../types';

// Isolate only the attachment drafting/send path. Real ChatThread, Composer and
// AttachmentTray are rendered. No Supabase, storage, worker or external send runs.
vi.mock("@/hooks/chat-zalo/useZaloMedia", () => ({ ZaloMediaSendError: class extends Error {} }));
vi.mock("@/components/chat-zalo/ThreadHeader", () => ({ default: ({ conv }: { conv: ZaloConversation }) => <div data-testid="recipient">{conv.name}</div> }));
vi.mock("@/components/chat-zalo/MessageList", () => ({ default: () => null }));
vi.mock("@/components/chat-zalo/ThreadSearchBar", () => ({ default: () => null }));
vi.mock("@/components/chat-zalo/TemplatePicker", () => ({ default: () => null }));
vi.mock("@/components/chat-zalo/composer/EmojiPicker", () => ({ default: () => null }));
vi.mock("@/components/chat-zalo/composer/StickerPicker", () => ({ default: () => null }));
import ChatThread from "@/components/chat-zalo/ChatThread";

beforeEach(() => {
  let number = 0;
  URL.createObjectURL = vi.fn(() => `blob:repro-${++number}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const common = { draft: '', templates: [], onDraft: vi.fn(), onSend: vi.fn(), onPickTemplate: vi.fn() };
const conversation = (id: string) => ({ id, name: `Customer ${id}`, accountId: 'account-1', messages: [] }) as ZaloConversation;
function choosePhoto(container: HTMLElement, name: string) {
  const file = new File(['image-content'], name, { type: 'image/png' });
  fireEvent.change(container.querySelector('input[type=file][accept]')!, { target: { files: [file] } });
  return file;
}
it("keeps attachments bound to their original conversation", async () => {
  URL.createObjectURL = vi.fn(() => "blob:repro");
  URL.revokeObjectURL = vi.fn();
  const send = vi.fn().mockResolvedValue(undefined);
  const file = new File(["image-content"], "only-for-customer-a.png", { type: "image/png" });
  const common = { draft: "", templates: [], onDraft: vi.fn(), onSend: vi.fn(), onPickTemplate: vi.fn() };
  const thread = (id: string) => <ChatThread
    {...common}
    conv={conversation(id)}
    onSendMedia={(kind, files, caption) => send({ conversationId: id, kind, files, caption })}
  />;
  // Same component position and no key, matching ChatZaloPage.tsx:295-298.
  const ui = render(thread("A"));
  const input = ui.container.querySelector("input[type=file][accept]") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  fireEvent.change(screen.getByPlaceholderText("Thêm chú thích…"), { target: { value: "Private draft for A" } });
  expect(screen.getByAltText(file.name)).toBeTruthy();
  ui.rerender(thread("B"));
  expect(screen.getByTestId("recipient").textContent).toBe("Customer B");
  expect(screen.queryByAltText(file.name)).toBeNull();
  expect(screen.queryByPlaceholderText("Thêm chú thích…")).toBeNull();
  expect(send).not.toHaveBeenCalled();
  ui.rerender(thread("A"));
  expect(screen.getByAltText(file.name)).toBeTruthy();
  fireEvent.keyDown(screen.getByPlaceholderText("Thêm chú thích…"), { key: "Enter" });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledWith({ conversationId: "A", kind: "image", files: [file], caption: "Private draft for A" });
});

it('completion of A cannot clear the attachment/caption currently drafted in B', async () => {
  let finishA!: () => void;
  const resultA = new Promise<void>(resolve => { finishA = resolve; });
  const send = vi.fn((id: string) => id === 'A' ? resultA : Promise.resolve());
  const thread = (id: string) => <ChatThread {...common} conv={conversation(id)} onSendMedia={() => send(id)} />;
  const ui = render(thread('A'));
  choosePhoto(ui.container, 'a.png');
  fireEvent.keyDown(screen.getByPlaceholderText('Thêm chú thích…'), { key: 'Enter' });
  expect(send).toHaveBeenCalledWith('A');
  ui.rerender(thread('B'));
  choosePhoto(ui.container, 'b.png');
  fireEvent.change(screen.getByPlaceholderText('Thêm chú thích…'), { target: { value: 'For B only' } });
  await act(async () => { finishA(); await resultA; });
  expect(screen.getByAltText('b.png')).toBeTruthy();
  expect((screen.getByPlaceholderText('Thêm chú thích…') as HTMLInputElement).value).toBe('For B only');
  ui.rerender(thread('A'));
  expect(screen.queryByAltText('a.png')).toBeNull();
});

it('cancels voice capture if microphone permission arrives after switching conversations', async () => {
  let grant!: (stream: MediaStream) => void;
  const streamPromise = new Promise<MediaStream>(resolve => { grant = resolve; });
  const stop = vi.fn();
  const recorder = vi.fn();
  vi.stubGlobal('MediaRecorder', recorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => streamPromise) } });
  const send = vi.fn();
  const thread = (id: string) => <ChatThread {...common} conv={conversation(id)} onSendVoice={send} />;
  const ui = render(thread('A'));
  fireEvent.click(screen.getByTitle('Ghi âm'));
  ui.rerender(thread('B'));
  await act(async () => { grant({ getTracks: () => [{ stop }] } as unknown as MediaStream); await streamPromise; });
  expect(stop).toHaveBeenCalledOnce();
  expect(recorder).not.toHaveBeenCalled();
  expect(screen.queryByTitle('Gửi tin thoại')).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('shows query errors and retry inside the thread without discarding its text draft', () => {
  const retry = vi.fn();
  render(<ChatThread {...common} draft="Keep this draft" conv={conversation('A')} messagesQuery={{ data: undefined, status: 'error', fetchStatus: 'idle', isLoading: false, isError: true, error: new Error('Offline'), refetch: retry }} />);
  expect(screen.getByRole('alert').textContent).toContain('Chưa tải được tin nhắn Zalo');
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Tải lại' }));
  return waitFor(() => expect(retry).toHaveBeenCalledOnce());
});
