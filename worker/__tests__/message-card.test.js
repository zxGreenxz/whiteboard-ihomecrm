// Tin dạng thẻ của Zalo: 484 tin production từng hiện nguyên chữ "sendBubbleMessage"
// (đo 09/10/2026). Module thuần, không mock gì.
import { describe, it, expect } from 'vitest';

import { docThe, chuCuaThe, laChuoiMay, phanLoaiTinThe } from '../lib/message-card.js';

const tin = (msgType, content) => ({ data: { msgType, content, msgId: '1' } });

describe('phanLoaiTinThe', () => {
  it('thẻ link giữ tiêu đề, mô tả, link, ảnh nhỏ và hiện tiêu đề làm chữ', () => {
    const r = phanLoaiTinThe(tin('chat.recommended', {
      action: 'recommened.link', title: 'Phòng trọ Quận 7', description: 'Còn 2 phòng',
      href: 'https://example.com/phong?id=7', thumb: 'https://photo.example.com/t.jpg',
    }));
    expect(r).toEqual({
      msg_type: 'text', body: 'Phòng trọ Quận 7', media_url: null, media_label: null,
      media_meta: { card: {
        kind: 'link', action: 'recommened.link', title: 'Phòng trọ Quận 7', description: 'Còn 2 phòng',
        href: 'https://example.com/phong?id=7', thumb: 'https://photo.example.com/t.jpg',
      } },
    });
  });

  it('title là tên hàm "sendBubbleMessage" thì bỏ, lấy mô tả làm chữ', () => {
    const r = phanLoaiTinThe(tin('chat.recommended', { title: 'sendBubbleMessage', description: 'Lời nhắn nổi bật' }));
    expect(r.body).toBe('Lời nhắn nổi bật');
    expect(r.media_meta.card.title).toBeNull();
    expect(r.media_meta.card.kind).toBe('card');
  });

  it('thẻ không còn chữ nào cho người đọc thì ghi "[Tin dạng thẻ]", không bao giờ ra chuỗi máy', () => {
    const r = phanLoaiTinThe(tin('chat.recommended', { title: 'sendBubbleMessage' }));
    expect(r.body).toBe('[Tin dạng thẻ]');
  });

  it('danh thiếp nhận theo action user và theo share.contact', () => {
    const a = phanLoaiTinThe(tin('chat.recommended', { action: 'recommened.user', title: 'Anh Minh' }));
    expect(a.media_meta.card.kind).toBe('contact');
    expect(a.body).toBe('[Danh thiếp] Anh Minh');
    const b = phanLoaiTinThe(tin('share.contact', { title: '' }));
    expect(b.body).toBe('[Danh thiếp]');
  });

  it('link không phải http(s) bị bỏ, không để web bấm mở', () => {
    const r = phanLoaiTinThe(tin('chat.link', { title: 'x', href: 'javascript:alert(1)', thumb: 'data:image/png;base64,AA' }));
    expect(r.media_meta.card.href).toBeNull();
    expect(r.media_meta.card.thumb).toBeNull();
    expect(r.media_meta.card.kind).toBe('card');
  });

  it('chữ dài bị cắt ở 500 ký tự', () => {
    const r = phanLoaiTinThe(tin('chat.recommended', { title: 'a'.repeat(900) }));
    expect(r.media_meta.card.title).toHaveLength(500);
  });

  it('không phải tin thẻ thì trả null để classifyMessage xử lý như cũ', () => {
    expect(phanLoaiTinThe(tin('chat.photo', { href: 'https://x/y.jpg' }))).toBeNull();
    expect(phanLoaiTinThe(tin('webchat', 'xin chào'))).toBeNull();
    expect(phanLoaiTinThe(tin('chat.recommended', 'chuỗi'))).toBeNull();
    expect(phanLoaiTinThe({})).toBeNull();
  });
});

describe('laChuoiMay / chuCuaThe / docThe', () => {
  it('chỉ coi tên hàm kiểu sendXxx là chuỗi máy', () => {
    expect(laChuoiMay('sendBubbleMessage')).toBe(true);
    expect(laChuoiMay(' sendCard ')).toBe(true);
    expect(laChuoiMay('send me the room list')).toBe(false);
    expect(laChuoiMay('Gửi phòng')).toBe(false);
  });

  it('thẻ chỉ có link thì chữ là chính link', () => {
    const the = docThe('chat.recommended', { href: 'https://example.com/' });
    expect(chuCuaThe(the)).toBe('https://example.com/');
  });
});
