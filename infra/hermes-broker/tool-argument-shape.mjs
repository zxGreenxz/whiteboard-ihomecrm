// Some routed models (cx/gpt-6-sol via 9router, 16/10/2026) cannot send JSON
// null reliably: for a required ['string','null'] field they send the nil UUID,
// a blank string or nothing, then repeat the same rejected call. The broker
// therefore advertises such fields as omittable and maps those placeholders to
// null against the ORIGINAL definition before any validator. Validators stay the
// only acceptance fence; nothing else in the arguments is touched.
const NIL_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const OMITTABLE = 'Bỏ trống nếu không có.';
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const nullable = property => Array.isArray(property?.type) && property.type.includes('null');
const own = (value, key) => plain(value) && Object.hasOwn(value, key) ? value[key] : undefined;

// Top level only. Required+nullable: absent/blank/(nil UUID if format uuid) -> null.
// Optional nullable UUID: blank/nil UUID -> null, absence stays absence. Optional
// non-UUID fields (crm_room_pass_upsert: absent = keep, null = clear) never match.
function nullableFields(tool) {
  const schema = own(tool, 'inputSchema'), properties = own(schema, 'properties'), required = own(schema, 'required');
  if (!plain(properties)) return [];
  const needed = key => Array.isArray(required) && required.includes(key);
  return Object.entries(properties).filter(([key, property]) => nullable(property) && (needed(key) || property.format === 'uuid'))
    .map(([key, property]) => Object.freeze({ key, required: needed(key), uuid: property.format === 'uuid' }));
}

export function advertisedTool(tool) {
  const copy = structuredClone(tool), schema = own(copy, 'inputSchema'), properties = own(schema, 'properties');
  if (!Array.isArray(own(schema, 'required')) || !plain(properties)) return copy;
  const omittable = schema.required.filter(key => nullable(own(properties, key)));
  schema.required = schema.required.filter(key => !omittable.includes(key));
  // A fresh object per key: structuredClone keeps shared property objects shared
  // (crm_task_create roomId/assigneeId), so in-place edits would apply twice.
  for (const key of omittable) properties[key] = { ...properties[key], description: [properties[key].description, OMITTABLE].filter(Boolean).join(' ') };
  return copy;
}

export function normalizeToolArguments(tool, args) {
  try {
    if (!plain(args)) return args;
    // Descriptor copy: accessors, prototype and every other key reach the
    // validator exactly as supplied (an accessor is still rejected there).
    const descriptors = Object.getOwnPropertyDescriptors(args);
    for (const { key, required, uuid } of nullableFields(tool)) {
      const current = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
      if (!current) { if (required) descriptors[key] = { value: null, writable: true, enumerable: true, configurable: true }; continue; }
      const text = Object.hasOwn(current, 'value') && typeof current.value === 'string' ? current.value.trim() : undefined;
      if (text === '' || (uuid && text !== undefined && NIL_UUID.test(text))) descriptors[key] = { ...current, value: null };
    }
    return Object.defineProperties(Object.create(Object.getPrototypeOf(args)), descriptors);
  } catch { return args; }
}
