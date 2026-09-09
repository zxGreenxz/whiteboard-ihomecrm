export interface ActivePageContext {
  filters: readonly string[];
  incompleteFilters: boolean;
  entityId?: string;
  unresolvedEntity?: boolean;
}

export interface ActivePageScope {
  pathname: string;
  search: string;
  key: string;
  organizationId: string | null;
}

export function isContextEntityId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

// One mounted page, no storage scan or event bus. Read at send time so filter
// changes do not require rerendering the chat panel. Cleanup owns its entry.
let active: { scope: ActivePageScope; context: ActivePageContext } | undefined;

export function publishActivePageContext(scope: ActivePageScope, context: ActivePageContext): () => void {
  const entry = { scope, context };
  active = entry;
  return () => { if (active === entry) active = undefined; };
}

export function readActivePageContext(scope: ActivePageScope): ActivePageContext | undefined {
  const previous = active?.scope;
  if (!previous || !scope.organizationId || previous.organizationId !== scope.organizationId
    || previous.pathname !== scope.pathname || previous.search !== scope.search || previous.key !== scope.key) return undefined;
  return active?.context;
}
