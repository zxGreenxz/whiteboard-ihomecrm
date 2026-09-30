/** Existing password policy, shared by desktop and mobile forms. */
export function passwordFieldErrors(password: string, confirmation: string): Record<string, string> {
 const errors: Record<string, string> = {};
 if (!password) errors.newPassword = 'Nhập mật khẩu mới.';
 else if (password.length < 6) errors.newPassword = 'Mật khẩu mới phải có ít nhất 6 ký tự.';
 if (!confirmation) errors.confirmPassword = 'Nhập lại mật khẩu mới.';
 else if (confirmation !== password) errors.confirmPassword = 'Mật khẩu xác nhận không khớp.';
 return errors;
}

export class AvatarProfilePartialError extends Error {
 constructor(readonly uploadedUrl: string, readonly cause: unknown, readonly profileId?: string) {
  super('Ảnh đã tải lên nhưng chưa xác nhận được đã gắn vào hồ sơ. Kiểm tra ảnh đại diện hiện tại trước khi tải lại.');
  this.name = 'AvatarProfilePartialError';
 }
}
