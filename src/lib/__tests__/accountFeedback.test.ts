import { describe, expect, it } from 'vitest';

import { adminPasswordProblem, MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS } from '../accountFeedback';

/**
 * Luật mật khẩu khi quản trị đặt lại cho người khác. Hàm Edge kiểm lại đúng luật này; hai hằng
 * được đối chiếu với mã Deno ở edgeFunctions.test.ts.
 *
 * Chữ tiếng Việt viết bằng mã \u để tệp không phụ thuộc cách trình soạn thảo chuẩn hoá Unicode.
 */
const E_NANG_MU = 'ệ'; // "ệ" dựng sẵn: 1 ký tự, 3 byte UTF-8
const D_GACH = 'đ'; // "đ": 1 ký tự, 2 byte UTF-8

describe('adminPasswordProblem', () => {
  it('rỗng ⇒ yêu cầu nhập', () => {
    expect(adminPasswordProblem('')).toBe('Nhập mật khẩu mới.');
  });

  it(`biên ${MIN_PASSWORD_CHARS - 1}/${MIN_PASSWORD_CHARS} ký tự, đếm theo code point`, () => {
    expect(adminPasswordProblem('abcde')).toBe('Mật khẩu phải có ít nhất 6 ký tự.');
    expect(adminPasswordProblem('abcdef')).toBeNull();
    // Chữ có dấu: mỗi chữ là MỘT ký tự dù tốn nhiều byte.
    expect(adminPasswordProblem(E_NANG_MU.repeat(5))).toMatch(/ít nhất 6 ký tự/);
    expect(adminPasswordProblem(E_NANG_MU.repeat(6))).toBeNull();
    // Emoji: `.length` là 2 mỗi cái; năm cái vẫn chỉ là 5 ký tự ⇒ thiếu.
    expect(adminPasswordProblem('\u{1F600}'.repeat(5))).toMatch(/ít nhất 6 ký tự/);
    expect(adminPasswordProblem('\u{1F600}'.repeat(6))).toBeNull();
  });

  it(`biên ${MAX_PASSWORD_BYTES}/${MAX_PASSWORD_BYTES + 1} byte UTF-8, kể cả chữ tiếng Việt nhiều byte`, () => {
    expect(adminPasswordProblem('a'.repeat(72))).toBeNull();
    expect(adminPasswordProblem('a'.repeat(73))).toMatch(/tối đa 72 byte/);
    // 24 × 3 byte = 72 byte (chỉ 24 ký tự) ⇒ vừa khít; thêm một chữ là quá.
    expect(adminPasswordProblem(E_NANG_MU.repeat(24))).toBeNull();
    expect(adminPasswordProblem(`${E_NANG_MU.repeat(24)}a`)).toMatch(/tối đa 72 byte/);
    // 36 × 2 byte = 72 byte.
    expect(adminPasswordProblem(D_GACH.repeat(36))).toBeNull();
    expect(adminPasswordProblem(`${D_GACH.repeat(35)}${E_NANG_MU}`)).toMatch(/tối đa 72 byte/);
    // 71 ký tự (< 72) nhưng 69 + 3 + 2 = 74 byte ⇒ phải chặn; đếm theo ký tự sẽ để lọt.
    expect(adminPasswordProblem(`${'a'.repeat(69)}${D_GACH}`)).toBeNull(); // 71 byte
    expect(adminPasswordProblem(`${'a'.repeat(69)}${E_NANG_MU}${D_GACH}`)).toMatch(/tối đa 72 byte/);
  });

  it('khoảng trắng ở đầu hoặc cuối bị từ chối, ở giữa thì được', () => {
    for (const matKhau of [' abcdef', 'abcdef ', '\tabcdef', 'abcdef\n', ' abcdef', 'abcdef　', '      ']) {
      expect(adminPasswordProblem(matKhau), JSON.stringify(matKhau)).toBe(
        'Mật khẩu không được có dấu cách ở đầu hoặc cuối.',
      );
    }
    expect(adminPasswordProblem('abc def')).toBeNull();
  });

  it('nửa cặp UTF-16 đứng lẻ (dán dữ liệu hỏng) bị từ chối như hàm Edge `isWellFormed()`', () => {
    for (const matKhau of ['abcdef\ud800', '\udc00abcdef', 'abc\ud83dxyz']) {
      expect(adminPasswordProblem(matKhau), JSON.stringify(matKhau)).toBe('Mật khẩu có ký tự không hợp lệ.');
    }
    // Cặp đủ đôi (emoji) thì hợp lệ.
    expect(adminPasswordProblem('abcde😀')).toBeNull();
  });
});
