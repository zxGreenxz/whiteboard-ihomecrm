export const HERMES_CAPABILITIES: Readonly<Record<string, Readonly<{
  mode: 'read' | 'action'; resource: 'self' | 'building' | 'organization' | 'organization_scope';
}>>>;
export const HERMES_READ_CAPABILITIES: readonly string[];
export const HERMES_ACTION_CAPABILITIES: readonly string[];
export function requiresBuildingScope(read: readonly string[], action?: readonly string[]): boolean;
export function mayUseGroupTool(effective: { read?: readonly string[]; action?: readonly string[] } | undefined, operation: string): boolean;
