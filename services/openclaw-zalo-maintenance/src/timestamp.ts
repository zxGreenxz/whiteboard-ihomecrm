const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function timestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value !== value.trim() ||
    !RFC3339_TIMESTAMP.test(value) || !Number.isFinite(new Date(value).valueOf())
  ) {
    throw new TypeError(`${name} is not an RFC3339 timestamp`);
  }
  return value;
}
