// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { detectTamTruExtension, sendTamTruPayload, TAM_TRU_EXT_ATTR } from '../tamTruBridge';
import type { TamTruPayload } from '../tamTruPayload';

const payload: TamTruPayload = {
  version: 1, createdAt: 'x', customerId: 'c', buildingName: 'b', roomNumber: '1',
  receive: { provinceName: 'p', wardName: 'w' },
  person: { fullName: 'n', dob: '01/01/2000', genderCode: '2', idNumber: '000000000000', phone: '', email: '' },
  address: 'a', household: { relationshipCode: 'CH01' }, tempResidentTo: '01/01/2028', attachments: [],
};

describe('detectTamTruExtension', () => {
  afterEach(() => document.documentElement.removeAttribute(TAM_TRU_EXT_ATTR));
  it('đọc phiên bản từ thuộc tính do extension đặt', () => {
    expect(detectTamTruExtension()).toBeNull();
    document.documentElement.setAttribute(TAM_TRU_EXT_ATTR, '1.0.0');
    expect(detectTamTruExtension()).toBe('1.0.0');
  });
});

describe('sendTamTruPayload', () => {
  it('gửi postMessage và chờ ACK đúng requestId', async () => {
    const seen: unknown[] = [];
    const responder = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; requestId?: string; payload?: unknown };
      if (d?.source === 'ihome-crm' && d.type === 'TAM_TRU_PAYLOAD') {
        seen.push(d.payload);
        window.postMessage({ source: 'ihome-tamtru-ext', type: 'TAM_TRU_ACK', requestId: 'sai', ok: true }, '*');
        window.postMessage({ source: 'ihome-tamtru-ext', type: 'TAM_TRU_ACK', requestId: d.requestId, ok: true }, '*');
      }
    };
    window.addEventListener('message', responder);
    try {
      await expect(sendTamTruPayload(payload, window, 1000)).resolves.toBeUndefined();
      expect(seen[0]).toEqual(payload);
    } finally {
      window.removeEventListener('message', responder);
    }
  });

  it('chuyển lỗi từ extension', async () => {
    const responder = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; requestId?: string };
      if (d?.source === 'ihome-crm') window.postMessage({ source: 'ihome-tamtru-ext', type: 'TAM_TRU_ACK', requestId: d.requestId, ok: false, error: 'Lỗi thử' }, '*');
    };
    window.addEventListener('message', responder);
    try {
      await expect(sendTamTruPayload(payload, window, 1000)).rejects.toThrow('Lỗi thử');
    } finally {
      window.removeEventListener('message', responder);
    }
  });

  it('báo không phản hồi khi hết giờ', async () => {
    await expect(sendTamTruPayload(payload, window, 50)).rejects.toThrow(/không phản hồi/i);
  });
});
