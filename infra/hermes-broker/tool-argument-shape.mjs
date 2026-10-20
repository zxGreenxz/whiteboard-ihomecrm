// Some routed models (cx/gpt-6-sol via 9router, 16/10/2026) cannot send JSON
// null reliably: for a required ['string','null'] field they send the nil UUID,
// a blank string or nothing, then repeat the same rejected call. The broker
// therefore advertises such fields as omittable and maps those placeholders to
// null against the ORIGINAL definition before any validator. Validators stay the
// only acceptance fence; beyond that and the read-tool aliases below
// (shapeReadArguments) nothing in the arguments is touched.
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

// 20/10/2026 (production trace, 18 standard questions): a model that calls a
// hidden read tool straight away guesses snake_case names (from_date/to_date,
// building_id) or a limit above the ceiling, is rejected and calls again
// (≈3–5 s per miss). Read tools (readOnlyHint) therefore accept, top level only:
// a snake_case key whose camelCase form is a schema property the call does not
// already carry (both present: camelCase wins, the snake key is dropped), and an
// integer `limit` outside minimum..maximum clamped to that bound. No synonym is
// guessed (start_date, type stay unknown keys for the validator); write tools
// and the advertised definitions are untouched. The camelCase form must be an
// own schema property, so `__proto__` and the like can never become a target.
const camelCase = key => key.replace(/_+([a-zA-Z0-9])/g, (_, next) => next.toUpperCase());
function shapeReadArguments(tool, descriptors) {
  if (own(tool, 'annotations')?.readOnlyHint !== true) return;
  const properties = own(own(tool, 'inputSchema'), 'properties');
  if (!plain(properties)) return;
  for (const key of Object.keys(descriptors)) {
    if (!key.includes('_')) continue;
    const target = camelCase(key);
    if (target === key || !Object.hasOwn(properties, target)) continue;
    if (!Object.hasOwn(descriptors, target)) descriptors[target] = descriptors[key];
    delete descriptors[key];
  }
  const limit = own(properties, 'limit'), current = Object.hasOwn(descriptors, 'limit') ? descriptors.limit : undefined;
  if (!plain(limit) || !current || !Object.hasOwn(current, 'value') || !Number.isSafeInteger(current.value)) return;
  const { minimum, maximum } = limit;
  if (Number.isSafeInteger(maximum) && current.value > maximum) descriptors.limit = { ...current, value: maximum };
  else if (Number.isSafeInteger(minimum) && current.value < minimum) descriptors.limit = { ...current, value: minimum };
}

export function normalizeToolArguments(tool, args) {
  try {
    if (!plain(args)) return args;
    // Descriptor copy: accessors, prototype and every other key reach the
    // validator exactly as supplied (an accessor is still rejected there).
    const descriptors = Object.getOwnPropertyDescriptors(args);
    // Aliases first: an aliased nullable UUID (building_id: nil) still becomes null below.
    shapeReadArguments(tool, descriptors);
    for (const { key, required, uuid } of nullableFields(tool)) {
      const current = Object.hasOwn(descriptors, key) ? descriptors[key] : undefined;
      if (!current) { if (required) descriptors[key] = { value: null, writable: true, enumerable: true, configurable: true }; continue; }
      const text = Object.hasOwn(current, 'value') && typeof current.value === 'string' ? current.value.trim() : undefined;
      if (text === '' || (uuid && text !== undefined && NIL_UUID.test(text))) descriptors[key] = { ...current, value: null };
    }
    return Object.defineProperties(Object.create(Object.getPrototypeOf(args)), descriptors);
  } catch { return args; }
}
