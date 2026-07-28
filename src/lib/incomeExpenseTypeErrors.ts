type SupabaseLikeError =
  | { code?: unknown; message?: unknown }
  | null
  | undefined;

export function incomeExpenseTypeErrorMessage(
  error: SupabaseLikeError,
  fallback: string,
): string {
  if (error?.code === "23505") {
    return "Hạng mục này đã tồn tại trong tổ chức";
  }

  return typeof error?.message === "string" && error.message.trim()
    ? error.message
    : fallback;
}
