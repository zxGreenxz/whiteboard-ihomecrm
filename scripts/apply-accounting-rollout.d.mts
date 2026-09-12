export type SupabaseAdminConfig = { pat: string; projectRef: string };
export function stripMigrationTransactionControl(sql: string, file?: string): string;
export function loadSupabaseAdminConfig(options?: {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string | URL, encoding: BufferEncoding) => string;
}): SupabaseAdminConfig;
