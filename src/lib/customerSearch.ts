// Từ 17/10/2026 màn Khách hàng tìm qua customer_list_v1; bản SQL của hàm này là
// public.customer_search_patterns_v1. File giữ làm bản đối chiếu: customerListMigration.test.ts
// chứng minh hai bên dựng ĐÚNG cùng hai regex.
const vietnameseLetters = {
  a: 'aàáạảãâầấậẩẫăằắặẳẵ',
  e: 'eèéẹẻẽêềếệểễ',
  i: 'iìíịỉĩ',
  o: 'oòóọỏõôồốộổỗơờớợởỡ',
  u: 'uùúụủũưừứựửữ',
  y: 'yỳýỵỷỹ',
  d: 'dđ',
};
const variantsByLetter = new Map(Object.values(vietnameseLetters)
  .flatMap(letters => Array.from(letters, letter => [letter, letters] as const)));

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** PostgREST imatch runs on the server, before count/range. Quoting keeps
 * punctuation in user input from becoming extra PostgREST conditions. */
export function customerSearchFilter(search: string): string {
  const name = Array.from(search.trim().normalize('NFC').toLowerCase(), letter => {
    const variants = variantsByLetter.get(letter);
    // Accept both precomposed Vietnamese letters and NFD combining marks.
    return variants ? `[${variants}][\u0300-\u036f]*` : escapeRegex(letter);
  }).join('');
  const literal = JSON.stringify(escapeRegex(search.trim()));
  return [
    `full_name.imatch.${JSON.stringify(name)}`,
    ...['phone', 'email', 'id_number'].map(field => `${field}.imatch.${literal}`),
  ].join(',');
}
