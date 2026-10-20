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

// A fresh object per key: structuredClone keeps shared property objects shared
// (crm_task_create roomId/assigneeId), so in-place edits would apply twice.
const hinted = property => typeof property.description === 'string' && property.description.includes(OMITTABLE) ? property :
  { ...property, description: [property.description, OMITTABLE].filter(Boolean).join(' ') };

// 20/10/2026 (measured): Hermes (upstream v0.21.6) rewrites ['string','null'] as
// {"type":"string","nullable":true} before the model sees it. `nullable` is not
// standard on OpenAI-compatible routes and gpt-6 (sol/astra) froze right after
// `"cursor":` on 6/6 crm_read_customers calls. Read tools (readOnlyHint) are
// therefore advertised with no null at the top level: a nullable type keeps its
// non-null types and loses format:uuid, an enum loses null (and the property
// when nothing is left, e.g. status of a domain without statuses). A converted
// field gets OMITTABLE unless it is a UUID: a blank or nil UUID already becomes
// null above, while a blank date/enum/number would reach the validator (and the
// hint costs 44 B per field of a 64 000 B tools/list). The original stays the
// validator's and normalizeToolArguments' only definition. Write tools keep the
// original shape beyond required-nullable: absent = keep and null = clear differ.
function advertisedReadProperty(property) {
  if (nullable(property)) {
    const types = property.type.filter(type => type !== 'null'), shaped = { ...property, type: types.length === 1 ? types[0] : types };
    if (shaped.format !== 'uuid') return hinted(shaped);
    delete shaped.format;
    return shaped;
  }
  if (!Array.isArray(property.enum) || !property.enum.includes(null)) return property;
  const values = property.enum.filter(value => value !== null);
  return values.length ? hinted({ ...property, enum: values }) : undefined;
}

export function advertisedTool(tool) {
  const copy = structuredClone(tool), schema = own(copy, 'inputSchema'), properties = own(schema, 'properties');
  if (!plain(properties)) return copy;
  const required = Array.isArray(own(schema, 'required')) ? schema.required : [];
  const omittable = required.filter(key => nullable(own(properties, key)));
  if (omittable.length) schema.required = required.filter(key => !omittable.includes(key));
  // Required+nullable (every tool): omittable, with the hint even next to an own description.
  for (const key of omittable) properties[key] = hinted(properties[key]);
  if (own(tool, 'annotations')?.readOnlyHint !== true) return copy;
  for (const [key, property] of Object.entries(properties)) {
    if (!plain(property)) continue;
    const shaped = advertisedReadProperty(property);
    if (shaped === undefined) { delete properties[key]; if (Array.isArray(schema.required)) schema.required = schema.required.filter(name => name !== key); }
    else properties[key] = shaped;
  }
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
