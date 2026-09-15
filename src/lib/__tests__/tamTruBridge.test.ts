// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectTamTruExtension, sendTamTruPayload, tamTruExtensionId,
  TAM_TRU_EXT_ATTR, TAM_TRU_EXT_ID, TAM_TRU_EXT_ID_ATTR,
} from '../tamTruBridge';
import type { TamTruPayload } from '../tamTruPayload';

const payload: TamTruPayload = {
  version: 1, createdAt: 'x', customerId: 'c', buildingName: 'b', roomNumber: '1',
  receive: { provinceName: 'p', wardName: 'w' },
  person: { fullName: 'n', dob: '01/01/2000', genderCode: '2', idNumber: '034208012538', phone: '', email: '' },
  address: 'a', household: { relationshipCode: 'CH01' }, tempResidentTo: '01/01/2028', attachments: [],
};

type Ack = { ok?: boolean; error?: string } | undefined;
interface FakeRuntime {
  lastError?: { message?: string };
  sendMessage: (id: string, message: unknown, cb: (r: Ack) => void) => void;
}
function installChrome(runtime: FakeRuntime | undefined) {
  (window as unknown as { chrome?: { runtime?: FakeRuntime } }).chrome = runtime ? { runtime } : undefined;
}

afterEach(() => {
  installChrome(undefined);
  document.documentElement.removeAttribute(TAM_TRU_EXT_ATTR);
  document.documentElement.removeAttribute(TAM_TRU_EXT_ID_ATTR);
});

describe('detectTamTruExtension', () => {
  it('đọc phiên bản từ thuộc tính do extension đặt', () => {
    expect(detectTamTruExtension()).toBeNull();
    document.documentElement.setAttribute(TAM_TRU_EXT_ATTR, '1.0.0');
    expect(detectTamTruExtension()).toBe('1.0.0');
  });
});

describe('tamTruExtensionId', () => {
  it('ưu tiên id trang thấy, rơi về id cố định', () => {
    expect(tamTruExtensionId()).toBe(TAM_TRU_EXT_ID);
    document.documentElement.setAttribute(TAM_TRU_EXT_ID_ATTR, 'abcdefghijklmnopabcdefghijklmnop');
    expect(tamTruExtensionId()).toBe('abcdefghijklmnopabcdefghijklmnop');
  });
});

describe('sendTamTruPayload', () => {
  it('gửi thẳng cho đúng extension, không phát tin nào trên window', async () => {
    const broadcast: unknown[] = [];
    const spy = (e: MessageEvent) => broadcast.push(e.data);
    window.addEventListener('message', spy);
    const sendMessage = vi.fn((_id: string, _msg: unknown, cb: (r: Ack) => void) => cb({ ok: true }));
    installChrome({ sendMessage });
    try {
      await expect(sendTamTruPayload(payload, window, 1000)).resolves.toBeUndefined();
      expect(sendMessage.mock.calls[0][0]).toBe(TAM_TRU_EXT_ID);
      expect(sendMessage.mock.calls[0][1]).toEqual({ type: 'TAM_TRU_PAYLOAD', payload });
      await new Promise((r) => setTimeout(r, 20));
      expect(broadcast).toEqual([]);
    } finally {
      window.removeEventListener('message', spy);
    }
  });

  it('chuyển lỗi từ extension', async () => {
    installChrome({ sendMessage: (_id, _msg, cb) => cb({ ok: false, error: 'Lỗi thử' }) });
    await expect(sendTamTruPayload(payload, window, 1000)).rejects.toThrow('Lỗi thử');
  });

  it('không có extension thì báo chưa sẵn sàng, không treo', async () => {
    installChrome(undefined);
    await expect(sendTamTruPayload(payload, window, 1000)).rejects.toThrow(/chưa sẵn sàng/i);
  });

  it('extension không nhận (lastError) cũng báo chưa sẵn sàng', async () => {
    const runtime: FakeRuntime = {
      lastError: { message: 'Could not establish connection.' },
      sendMessage: (_id, _msg, cb) => cb(undefined),
    };
    installChrome(runtime);
    await expect(sendTamTruPayload(payload, window, 1000)).rejects.toThrow(/chưa sẵn sàng/i);
  });

  it('extension im lặng thì hết giờ báo không phản hồi', async () => {
    installChrome({ sendMessage: () => { /* không gọi callback */ } });
    await expect(sendTamTruPayload(payload, window, 60)).rejects.toThrow(/không phản hồi/i);
  });
});
