/**
 * Môi trường đang chạy của bản build web.
 *
 * `VITE_APP_ENV=test` chỉ đặt cho Vercel Preview — nơi app trỏ vào project Supabase
 * TEST (bản sao đầy đủ production, xem scripts/test-env/). Production không đặt biến
 * này. Dữ liệu hai nơi GIỐNG HỆT nhau, nên thứ duy nhất cho người dùng biết mình
 * đang ở đâu là nhãn trên màn hình — thiếu nó thì rất dễ tưởng đang thao tác trên
 * sổ sách thật.
 */
export type AppEnvironment = 'production' | 'test';

export function docMoiTruong(giaTri: unknown): AppEnvironment {
  return typeof giaTri === 'string' && giaTri.trim().toLowerCase() === 'test' ? 'test' : 'production';
}

export const APP_ENV: AppEnvironment = docMoiTruong(import.meta.env?.VITE_APP_ENV);

export const IS_TEST_ENV = APP_ENV === 'test';
