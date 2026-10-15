export interface ActivePageContext {
  filters: readonly string[];
  incompleteFilters: boolean;
  entityId?: string;
  unresolvedEntity?: boolean;
}

export function isContextEntityId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}
