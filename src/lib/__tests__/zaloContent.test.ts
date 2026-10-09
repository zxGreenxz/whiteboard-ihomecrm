// Nội dung tin Zalo trên web: đo production 09/10/2026 có 484 tin hiện "sendBubbleMessage" và mọi
// link ảnh/video/file/voice nhận về đã 404. Chủ dự án chốt không tải file về, nên giao diện phải
// tự giải thích.
import { describe, expect, it } from 'vitest';

import {
  CHU_TIN_THE_CU,
  canhBaoKetNoi,
  chuHienThi,
  docThe,
  laLinkZalo,
  nhanMediaLoi,
  tenTrang,
} from '@/lib/zaloContent';
import type { ZaloAccount } from '@/components/chat-zalo/types';

const acc = (id: string, status: ZaloAccount['status'], extra: Partial<ZaloAccount> = {}): ZaloAccount => ({
  id, name: `Nick ${id}`, kind: 'personal', status, ...extra,
});

describe('chuHienThi', () => {
  it('đổi chuỗi máy của Zalo thành câu đọc được, giữ nguyên chữ người viết', () => {
    expect(chuHienThi('sendBubbleMessage')).toBe(CHU_TIN_THE_CU);
    expect(chuHienThi(' sendCard ')).toBe(CHU_TIN_THE_CU);
    expect(chuHienThi('send me the room list')).toBe('send me the room list');
    expect(chuHienThi('Còn phòng không ạ')).toBe('Còn phòng không ạ');
    expect(chuHienThi('')).toBe('');
  });
});

describe('docThe', () => {
  it('đọc thẻ worker ghi ở media_meta.card', () => {
    expect(docThe({ card: { kind: 'link', title: 'Phòng Q7', description: null, href: 'https://a.vn/p', thumb: 'https://t.vn/x.jpg' } }))
      .toEqual({ kind: 'link', title: 'Phòng Q7', description: null, href: 'https://a.vn/p', thumb: 'https://t.vn/x.jpg' });
  });

  it('lọc lại link không phải http(s) ở web', () => {
    const the = docThe({ card: { kind: 'link', title: 'x', href: 'javascript:alert(1)', thumb: '//evil.tld/a.png' } });
    expect(the?.href).toBeNull();
    expect(the?.thumb).toBeNull();
  });

  it('sai hình dạng thì null để web hiện chữ như tin thường', () => {
    expect(docThe(null)).toBeNull();
    expect(docThe({})).toBeNull();
    expect(docThe({ thumb: 'https://x/y.jpg', duration: 3 })).toBeNull();
    expect(docThe({ card: { kind: 'lạ', title: 'x' } })).toBeNull();
    expect(docThe({ card: 'chuỗi' })).toBeNull();
  });
});

describe('laLinkZalo / nhanMediaLoi', () => {
  it('nhận đúng máy chủ file của Zalo đã đo trên production', () => {
    for (const u of [
      'https://photo-stal-24.zdn.vn/a.jpg', 'https://f64-zpg-r.zdn.vn/b.jpg',
      'https://video-stal-16.dlmd.me/c.mp4', 'https://file-stal-8.dlfl.vn/d.pdf', 'https://s120.zadn.vn/e.jpg',
    ]) expect(laLinkZalo(u)).toBe(true);
    for (const u of ['https://tryymsxyyckgbrmmvozx.supabase.co/storage/v1/x.jpg', 'https://zdn.vn.evil.tld/a.jpg', 'không phải url', null, undefined]) {
      expect(laLinkZalo(u)).toBe(false);
    }
  });

  it('link Zalo lỗi ghi "có thể đã hết hạn trên Zalo", lỗi khác ghi "không tải được"', () => {
    expect(nhanMediaLoi('image', 'https://photo-stal-1.zdn.vn/a.jpg')).toBe('Ảnh không mở được — có thể đã hết hạn trên Zalo');
    expect(nhanMediaLoi('video', 'https://video-stal-1.dlmd.me/a.mp4')).toBe('Video không mở được — có thể đã hết hạn trên Zalo');
    expect(nhanMediaLoi('voice', 'https://file-stal-1.dlfl.vn/a.aac')).toBe('Tin thoại không mở được — có thể đã hết hạn trên Zalo');
    expect(nhanMediaLoi('image', 'stored:zalo-media/a/b.jpg')).toBe('Không tải được ảnh');
  });

  it('tenTrang lấy tên miền ngắn', () => {
    expect(tenTrang('https://www.example.com/a?b=1')).toBe('example.com');
    expect(tenTrang(null)).toBeNull();
  });
});

describe('canhBaoKetNoi', () => {
  const song = { online: true, heartbeatAt: '2026-10-10T01:00:00Z' };
  const chet = { online: false, heartbeatAt: '2026-09-05T07:56:26Z' };

  it('worker im lặng mà còn tài khoản cần nó thì báo mất kết nối kèm giờ nhịp tim cuối', () => {
    expect(canhBaoKetNoi(chet, [acc('a', 'connected')])).toEqual({ loai: 'worker', tu: chet.heartbeatAt });
  });

  it('worker đã nhả lease (nhịp tim mốc 1970) thì báo mất kết nối, không kèm giờ', () => {
    expect(canhBaoKetNoi({ online: false, heartbeatAt: '1970-01-01T00:00:00+00:00' }, [acc('a', 'connected')]))
      .toEqual({ loai: 'worker', tu: null });
  });

  it('mọi tài khoản đã ngắt thì không báo gì, kể cả khi worker tắt', () => {
    expect(canhBaoKetNoi(chet, [acc('a', 'disconnected')])).toBeNull();
    expect(canhBaoKetNoi(chet, [])).toBeNull();
  });

  it('worker sống mà phiên một tài khoản lỗi thì nhắc quét QR lại', () => {
    expect(canhBaoKetNoi(song, [acc('a', 'connected'), acc('b', 'error', { lastError: 'Phiên hết hạn' })]))
      .toEqual({ loai: 'phien', accountId: 'b', ten: 'Nick b', loi: 'Phiên hết hạn' });
  });

  it('chưa đọc được nhịp tim thì không kết luận worker chết, nhưng tài khoản lỗi vẫn báo', () => {
    expect(canhBaoKetNoi(undefined, [acc('a', 'connected')])).toBeNull();
    expect(canhBaoKetNoi(undefined, [acc('b', 'error')])?.loai).toBe('phien');
  });

  it('bình thường thì không báo gì', () => {
    expect(canhBaoKetNoi(song, [acc('a', 'connected'), acc('c', 'connecting')])).toBeNull();
  });

  it('tài khoản OA không đi qua worker: không làm bật cảnh báo, như phía SQL canh gác', () => {
    expect(canhBaoKetNoi(chet, [acc('oa', 'connected', { kind: 'oa' }), acc('a', 'disconnected')])).toBeNull();
    expect(canhBaoKetNoi(song, [acc('oa', 'error', { kind: 'oa' })])).toBeNull();
  });
});
