// Provider receipt for ONE plain-text Zalo send (zca-js 2.x sendMessage), shared
// by the native bridge and the CRM private-reply runner. No SDK import here.
//
// zca-js declares `message.msgId: number`, but the logged-in runtime can return
// it as a decimal string (worker/lib/queue.js already normalizes with String())
// and can add keys beside it. Only `message.msgId` is read, and only from own
// data properties: an accessor never runs. A valid positive ID is the sole proof
// of "sent"; every other shape returns null (= outcome unknown, never "sent").
const MESSAGE_ID = /^[1-9][0-9]{0,24}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function data(value, key) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property) return { present: false };
  if (!Object.hasOwn(property, 'value')) throw new Error('accessor');
  return { present: true, value: property.value };
}

export function providerTextReceipt(value) {
  try {
    if (!object(value)) return null;
    const message = data(value, 'message'), attachment = data(value, 'attachment');
    if (!message.present || !object(message.value)) return null;
    // A text send carries no attachment receipt: absent, or a plain empty array.
    if (attachment.present && (!Array.isArray(attachment.value) || Reflect.ownKeys(attachment.value).length !== 1 ||
        Object.getOwnPropertyDescriptor(attachment.value, 'length')?.value !== 0)) return null;
    const id = data(message.value, 'msgId');
    if (!id.present) return null;
    if (typeof id.value === 'number') return Number.isSafeInteger(id.value) && id.value > 0 ? String(id.value) : null;
    return typeof id.value === 'string' && MESSAGE_ID.test(id.value) ? id.value : null;
  } catch { return null; }
}

// Redacted shape for an operator fault: key names (bounded charset/length) and
// value kinds only, two levels deep. Never a value, text or ID.
const KEY = /^[A-Za-z0-9_$-]{1,32}$/;
export function describeReceiptShape(value, depth = 0) {
  try {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${Number(Object.getOwnPropertyDescriptor(value, 'length')?.value) || 0})`;
    if (typeof value !== 'object') return typeof value;
    if (depth >= 2) return 'object';
    const keys = Reflect.ownKeys(value);
    const parts = keys.slice(0, 12).map(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      const kind = !property ? 'missing' : !Object.hasOwn(property, 'value') ? 'accessor' : describeReceiptShape(property.value, depth + 1);
      return `${typeof key === 'string' && KEY.test(key) ? key : '?'}:${kind}`;
    });
    return `{${parts.join(',')}${keys.length > 12 ? ',...' : ''}}`;
  } catch { return 'unreadable'; }
}
