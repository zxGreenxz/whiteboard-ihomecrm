/** Existing password policy, shared by desktop and mobile forms. */
export function passwordFieldErrors(password: string, confirmation: string): Record<string, string> {
 const errors: Record<string, string> = {};
 if (!password) errors.newPassword = 'Nhập mật khẩu mới.';
 else if (password.length < 6) errors.newPassword = 'Mật khẩu mới phải có ít nhất 6 ký tự.';
 if (!confirmation) errors.confirmPassword = 'Nhập lại mật khẩu mới.';
 else if (confirmation !== password) errors.confirmPassword = 'Mật khẩu xác nhận không khớp.';
 return errors;
}

/**
 * Luật mật khẩu khi superadmin / chủ công ty đặt lại cho người khác. PHẢI khớp hàm Edge
 * `admin-reset-user-password`: test chống trôi (src/lib/__tests__/edgeFunctions.test.ts) đọc hai
 * hằng cùng tên bên Deno. Số ký tự đếm theo code point (`[...pw].length`); giới hạn trên đếm theo
 * byte UTF-8 nên chữ có dấu tiếng Việt tốn 2–3 byte mỗi chữ.
 */
export const MIN_PASSWORD_CHARS = 6;
export const MAX_PASSWORD_BYTES = 72;

/** Câu báo cho ô mật khẩu mới; `null` = hợp lệ. Máy chủ kiểm lại đúng luật này. */
export function adminPasswordProblem(password: string): string | null {
 if (!password) return 'Nhập mật khẩu mới.';
 // Nửa cặp UTF-16 đứng lẻ (chỉ lọt vào khi dán dữ liệu hỏng): hàm Edge từ chối bằng `isWellFormed()`.
 for (const kyTu of password) {
  const ma = kyTu.codePointAt(0) ?? 0;
  if (ma >= 0xd800 && ma <= 0xdfff) return 'Mật khẩu có ký tự không hợp lệ.';
 }
 if (password !== password.trim()) return 'Mật khẩu không được có dấu cách ở đầu hoặc cuối.';
 if ([...password].length < MIN_PASSWORD_CHARS) return `Mật khẩu phải có ít nhất ${MIN_PASSWORD_CHARS} ký tự.`;
 if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
  return `Mật khẩu quá dài: tối đa ${MAX_PASSWORD_BYTES} byte (mỗi chữ có dấu tính 2–3 byte).`;
 }
 return null;
}

export class AvatarProfilePartialError extends Error {
 constructor(readonly uploadedUrl: string, readonly cause: unknown, readonly profileId?: string) {
  super('Ảnh đã tải lên nhưng chưa xác nhận được đã gắn vào hồ sơ. Kiểm tra ảnh đại diện hiện tại trước khi tải lại.');
  this.name = 'AvatarProfilePartialError';
 }
}
