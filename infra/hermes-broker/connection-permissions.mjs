// Persisted intent is separate from the current registry projection. An absent
// mode is the original allowlist protocol, never implicit CRM inheritance.
export const CONNECTION_PERMISSION_FIELDS = ['permissionMode', 'exclusions', 'scopeMode'];
export function permissionShape(value, baseKeys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) return false;
  const keys = Reflect.ownKeys(value ?? {});
  return keys.length === baseKeys.length && baseKeys.every(key => keys.includes(key)) ||
    keys.length === baseKeys.length + 3 && [...baseKeys, ...CONNECTION_PERMISSION_FIELDS].every(key => keys.includes(key));
}
export function connectionPermissionSettings(value, parsePermissions, fail) {
  const present = CONNECTION_PERMISSION_FIELDS.filter(key => Object.hasOwn(value, key));
  if (!present.length) return {};
  if (present.length !== 3 || !['legacy_allowlist', 'inherit_crm'].includes(value.permissionMode) ||
      !['restricted', 'unrestricted'].includes(value.scopeMode)) fail();
  const exclusions = parsePermissions(value.exclusions);
  if (value.permissionMode === 'legacy_allowlist' && (exclusions.read.length || exclusions.action.length || value.scopeMode !== 'restricted')) fail();
  if (value.permissionMode === 'inherit_crm' && value.restrictions) {
    const projected = parsePermissions(value.restrictions);
    if (['read', 'action'].some(kind => projected[kind].some(key => exclusions[kind].includes(key)))) fail();
  }
  return { permissionMode: value.permissionMode, exclusions, scopeMode: value.scopeMode };
}
