/**
 * Môi trường đang chạy của bản build web.
 *
 * `VITE_APP_ENV=test` chỉ đặt cho Vercel Preview của nhánh `test-env` — nơi app trỏ vào
 * project Supabase TEST (bản sao đầy đủ production, xem scripts/test-env/). Production
 * không đặt biến này. Dữ liệu hai nơi GIỐNG HỆT nhau, nên thứ duy nhất cho người dùng
 * biết mình đang ở đâu là nhãn trên màn hình — thiếu nó thì rất dễ tưởng đang thao tác
 * trên sổ sách thật.
 *
 * Nhãn KHÔNG chỉ tin vào `VITE_APP_ENV`: nếu biến này lỡ được đặt cho một bản build vẫn
 * trỏ database production, nhãn "TEST" sẽ khiến người dùng yên tâm ghi vào sổ thật. Nên
 * chỉ coi là TEST khi URL database KHÔNG phải production; mâu thuẫn thì báo đỏ.
 */
export type AppEnvironment = 'production' | 'test';

const PROD_REF = 'tryymsxyyckgbrmmvozx';

export function docMoiTruong(giaTri: unknown): AppEnvironment {
  return typeof giaTri === 'string' && giaTri.trim().toLowerCase() === 'test' ? 'test' : 'production';
}

/** URL Supabase có phải production không. Không đọc được thì coi là production (an toàn). */
export function troProduction(url: unknown): boolean {
  return typeof url !== 'string' || url.trim() === '' || url.includes(PROD_REF);
}

const KHAI_TEST = docMoiTruong(import.meta.env?.VITE_APP_ENV) === 'test';
const TRO_PRODUCTION = troProduction(import.meta.env?.VITE_SUPABASE_URL);

/** Đúng là môi trường TEST: build khai TEST VÀ database không phải production. */
export const IS_TEST_ENV = KHAI_TEST && !TRO_PRODUCTION;

/** Cấu hình mâu thuẫn: build khai TEST nhưng database là PRODUCTION. */
export const MOI_TRUONG_MAU_THUAN = KHAI_TEST && TRO_PRODUCTION;

export const APP_ENV: AppEnvironment = IS_TEST_ENV ? 'test' : 'production';
