/** Single reader for the local credential vault; values are never printed. */
export interface VaultOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  repoRoot?: string;
  readFile?: (path: string, encoding: BufferEncoding) => string;
}
export const TEN_VAULT: string;
export const REPO_ROOT: string;
export const BIEN_TIEN_TRINH_CON: readonly string[];
export function mauNhanDang(ten: string): RegExp;
export function ungVienVault(opts?: Omit<VaultOptions, 'readFile'>): string[];
export function duongDanVault(opts?: Omit<VaultOptions, 'readFile'>): string | null;
export function docVault(opts?: VaultOptions): string;
export function quenVault(): void;
export function timTrongVault(mau: RegExp, opts?: VaultOptions): string | null;
export function giaTriVault(ten: string, opts?: VaultOptions): string | null;
export function docPatVault(opts?: VaultOptions): string | null;
export function layPat(opts?: VaultOptions & { bien?: string[] }): string | null;
export function docMatKhauPooler(vanBan: string): string | null;
export function layMatKhauDb(opts?: VaultOptions): string | null;
export function docTaiKhoanTest(opts?: VaultOptions): { email: string | null; password: string | null };
export function credentialChoTienTrinhCon(opts?: VaultOptions): { them: Record<string, string>; thieu: string[] };
