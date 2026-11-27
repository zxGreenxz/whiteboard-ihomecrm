import { createHash } from 'node:crypto';

// zca-js mforward encodes reference.data twice; mobile clients can also send
// decorLog.fw. Never treat a reply/quote, an author ID or a customer-supplied
// text field as the source of a forward.
function object(value) {
  if (typeof value === 'string' && value.length <= 4096) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function field(obj, key) {
  return obj && Object.getOwnPropertyDescriptor(obj, key)?.value;
}

function digits(value, pattern) {
  if (Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

export function forwardSource(event, data) {
  const references = new Set();
  let forwarded = false;
  for (const part of [data, event]) {
    const ref = object(field(part, 'reference'));
    const typed = field(ref, 'type') === 3 || field(ref, 'type') === '3';
    const fw = object(field(object(field(part, 'decorLog')), 'fw'));
    forwarded ||= typed || Boolean(fw);
    for (const source of [typed && object(field(ref, 'data')), field(fw, 'rmsg'), field(fw, 'pmsg')]) {
      const id = digits(field(source, 'id'), /^[1-9][0-9]{0,31}$/);
      const ts = digits(field(source, 'ts'), /^[1-9][0-9]{12}$/);
      if (id && ts) references.add(ts + '.' + createHash('sha256').update(id).digest('hex'));
    }
  }
  return { forwarded, ref: references.size === 1 ? [...references][0] : null };
}
