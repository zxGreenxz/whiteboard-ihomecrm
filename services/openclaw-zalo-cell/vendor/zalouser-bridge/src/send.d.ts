import type { PreparedProviderCallV1 } from "./bridge/send-context.js";

export type PreparedZaloProviderSession = Readonly<{ accountProfile: string }>;

export type BehaviorProbeZaloApiV1 = Readonly<{
  getContext(): { imei: string; userAgent: string; language?: string };
  getCookie(): { toJSON(): { cookies: unknown[] } };
  sendMessage(
    message: string | Record<string, unknown>,
    threadId: string,
    type?: number,
  ): Promise<{ msgId?: string | number; message?: { msgId?: string | number } | null }>;
  uploadAttachment(...args: unknown[]): Promise<Array<Record<string, unknown>>>;
  sendVoice(...args: unknown[]): Promise<{ msgId?: string | number }>;
  sendTypingEvent(...args: unknown[]): Promise<{ status: number }>;
}>;

export function prepareZaloProviderSession(
  accountProfile: string,
): PreparedZaloProviderSession;

export function installZaloBehaviorProbeProviderV1(
  accountProfile: string,
  api: BehaviorProbeZaloApiV1,
): () => void;

export function sendPreparedProviderCallZalouser(
  call: PreparedProviderCallV1,
  materializedMedia?: Buffer,
  preparedSession?: PreparedZaloProviderSession,
): Promise<{ providerMessageId?: string }>;

export function sendTypingZalouser(
  threadId: string,
  options?: Readonly<{ profile?: string; isGroup?: boolean }>,
): Promise<void>;
