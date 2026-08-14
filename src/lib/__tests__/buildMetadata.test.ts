// Bản build phải tự khai nó dựng từ commit nào, và khai SAI phải bị coi là không khai.
//
// Ca C38 của đánh giá live 13/08/2026 là lý do file này tồn tại: source CÓ tính
// năng đọc ảnh, unit test CÓ, nhưng deployment production KHÔNG có nút upload.
// Cả buổi thử 40 ca chạy trên một bản mà không ai biết chính xác là bản nào.
import { describe, expect, it } from 'vitest';
import { ganMetaBuildSha, shaHopLe } from '../../buildMetadata';

const SHA = 'a'.repeat(40);

describe('shaHopLe', () => {
  it('nhận đúng 40 ký tự hex thường', () => {
    expect(shaHopLe(SHA)).toBe(true);
    expect(shaHopLe('0ea9aa221aadeffc3cfc79e2f1a82736bd1fb7f5')).toBe(true);
  });

  it('TỪ CHỐI sha ngắn — phép so ở đây là bằng-hay-không-bằng', () => {
    // SHA ngắn đủ cho người đọc log, nhưng đây là so máy với máy. Một tiền tố
    // trùng nhau là chuyện hiếm, và "hiếm" là loại lỗi tệ nhất để đi tìm.
    expect(shaHopLe('0ea9aa2')).toBe(false);
    expect(shaHopLe('a'.repeat(39))).toBe(false);
    expect(shaHopLe('a'.repeat(41))).toBe(false);
  });

  it('TỪ CHỐI chuỗi rỗng và ký tự lạ', () => {
    expect(shaHopLe('')).toBe(false);
    expect(shaHopLe('unknown')).toBe(false);
    expect(shaHopLe('A'.repeat(40))).toBe(false); // hex thường, không hoa
    expect(shaHopLe(`${'a'.repeat(39)}-`)).toBe(false);
  });
});

/** DOM giả tối thiểu — repo cố ý không cài jsdom. */
function domGia() {
  const the: { name: string; content: string }[] = [];
  return {
    the,
    doc: {
      querySelector: (sel: string) =>
        sel === 'meta[name="build-sha"]' ? (the.find((t) => t.name === 'build-sha') ?? null) : null,
      createElement: () => ({ name: '', content: '' }),
      head: { appendChild: (el: { name: string; content: string }) => the.push(el) },
    },
  };
}

describe('ganMetaBuildSha', () => {
  it('gắn thẻ meta cùng nguồn khi SHA hợp lệ', () => {
    const { the, doc } = domGia();
    ganMetaBuildSha(SHA, doc);
    expect(the).toHaveLength(1);
    expect(the[0].name).toBe('build-sha');
    expect(the[0].content).toBe(SHA);
  });

  it('KHÔNG gắn gì khi SHA rỗng hoặc sai hình dạng', () => {
    // Một thẻ content="" trông như "đã khai" và làm người đọc tưởng phép kiểm
    // đang chạy. Thiếu hẳn thẻ thì E2E fail rõ ràng.
    for (const xau of ['', 'unknown', '0ea9aa2', 'A'.repeat(40)]) {
      const { the, doc } = domGia();
      ganMetaBuildSha(xau, doc);
      expect(the, `sha "${xau}" không được ghi gì`).toHaveLength(0);
    }
  });

  it('gọi hai lần không tạo thẻ trùng', () => {
    const { the, doc } = domGia();
    ganMetaBuildSha(SHA, doc);
    ganMetaBuildSha('b'.repeat(40), doc);
    expect(the).toHaveLength(1);
    expect(the[0].content).toBe('b'.repeat(40));
  });

  it('không có DOM thì im lặng bỏ qua, không ném', () => {
    // Chạy phía server hoặc trong worker: không có document là chuyện bình
    // thường, không phải lỗi.
    expect(() => ganMetaBuildSha(SHA, null)).not.toThrow();
  });
});
