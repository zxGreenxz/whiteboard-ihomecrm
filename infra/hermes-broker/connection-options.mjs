import { HERMES_READ_CAPABILITIES, HERMES_ACTION_CAPABILITIES, requiresBuildingScope } from './capability-contract.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER = ['userId', 'organizationId', 'membershipId'];
const KEYS = [...OWNER, 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'enabled', 'read', 'action', 'scopes'];
const SCOPE = ['scopeId', 'scopeType', 'label', 'buildingId', 'areaId', 'cashbookId'];
const fail = () => { throw new Error('connection_options_invalid'); };
const id = value => typeof value === 'string' && UUID.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
function own(raw, keys) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length !== keys.length) fail();
  return Object.fromEntries(keys.map(key => {
    const item = Object.getOwnPropertyDescriptor(raw, key);
    if (!item || !Object.hasOwn(item, 'value')) fail();
    return [key, item.value];
  }));
}
function array(raw, max) {
  if (!Array.isArray(raw) || raw.length > max || Reflect.ownKeys(raw).length !== raw.length + 1) fail();
  return Array.from({ length: raw.length }, (_, i) => {
    const item = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!item || !Object.hasOwn(item, 'value')) fail(); return item.value;
  });
}

/** Display choices from a caller-JWT RPC, never a cached grant. Keep the exact
 * browser/HTTP/management projection independent of private session material. */
export function connectionOptions(raw, organizationId, userId) {
  const value = own(raw, KEYS);
  if (!id(organizationId) || OWNER.some(key => !id(value[key])) || value.organizationId !== organizationId ||
      (userId !== undefined && value.userId !== userId) || !integer(value.authorizationVersion) || value.authorizationVersion < 1 ||
      !integer(value.policyVersion) || typeof value.enabled !== 'boolean' || typeof value.isSuperadmin !== 'boolean') fail();
  const read = array(value.read, HERMES_READ_CAPABILITIES.length), action = array(value.action, HERMES_ACTION_CAPABILITIES.length);
  if (read.some(key => !HERMES_READ_CAPABILITIES.includes(key)) || new Set(read).size !== read.length || new Set(action).size !== action.length || action.some(key => !HERMES_ACTION_CAPABILITIES.includes(key))) fail();
  const scopes = array(value.scopes, 256).map(rawScope => {
    const scope = own(rawScope, SCOPE);
    if (!id(scope.scopeId) || !['ORGANIZATION', 'AREA', 'BUILDING'].includes(scope.scopeType) ||
        typeof scope.label !== 'string' || !scope.label.trim() || scope.label.includes('\0') || Buffer.byteLength(scope.label) > 1024 ||
        scope.cashbookId !== null || !(scope.buildingId === null || id(scope.buildingId)) || !(scope.areaId === null || id(scope.areaId)) ||
        (scope.scopeType === 'BUILDING' ? !id(scope.buildingId) || scope.areaId !== null : scope.buildingId !== null) ||
        (scope.scopeType === 'AREA' ? !id(scope.areaId) : scope.areaId !== null)) fail();
    return Object.freeze(scope);
  });
  if (new Set(scopes.map(scope => scope.scopeId)).size !== scopes.length ||
      (!value.enabled && (read.length || action.length || scopes.length)) ||
      (requiresBuildingScope(read, action) !== (scopes.length > 0))) fail();
  return Object.freeze({ ...value, read: Object.freeze([...read].sort()), action: Object.freeze(action),
    scopes: Object.freeze(scopes.sort((a, b) => a.scopeId.localeCompare(b.scopeId))) });
}
