export class AcbParseError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AcbParseError';
    this.code = code;
  }
}

const MONEY = String.raw`((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?|(?:\d{1,3}(?:\.\d{3})+)(?:,\d{2})?)`;
const VN = new RegExp(String.raw`ACB trân trọng thông báo tài khoản\s+(\d{6,30})\b[\s\S]*?Số dư mới của tài khoản trên là:\s*${MONEY}\s+VND\s+tính đến\s+(\d{2}\/\d{2}\/\d{4})\s*\.\s*Giao dịch mới nhất:\s*(Ghi có|Ghi nợ)\s*([+-])\s*${MONEY}\s+VND\s*\.\s*Nội dung giao dịch:\s*([^\r\n]+)`, 'giu');
const EN = new RegExp(String.raw`ACB respectfully updates your\s+(\d{6,30})\s+account balance[\s\S]*?Updated account balance:\s*${MONEY}\s+VND\s+up to\s+(\d{2}\/\d{2}\/\d{4})\s*\.\s*Latest transaction:\s*(Credit|Debit)\s*([+-])\s*${MONEY}\s+VND\s*\.\s*Content:\s*([^\r\n]+)`, 'giu');

function money(raw) {
  const us = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?$/.test(raw);
  const vi = /^\d{1,3}(?:\.\d{3})+(?:,\d{2})?$/.test(raw);
  if (!us && !vi) throw new AcbParseError('INVALID_MONEY');
  const normalized = us ? raw.replaceAll(',', '') : raw.replaceAll('.', '').replace(',', '.');
  const [whole, fraction = '00'] = normalized.split('.');
  if (fraction !== '00') throw new AcbParseError('NON_INTEGER_VND');
  const amount = Number(whole);
  if (!Number.isSafeInteger(amount) || amount > 1e15) throw new AcbParseError('INVALID_MONEY');
  return amount;
}

function parseDate(date, time) {
  const [day, month, year] = date.split('/').map(Number);
  const [hours, minutes, seconds] = time.split(':').map(Number);
  const local = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 ||
      local.getUTCDate() !== day || local.getUTCHours() !== hours ||
      local.getUTCMinutes() !== minutes || local.getUTCSeconds() !== seconds) {
    throw new AcbParseError('INVALID_DATE');
  }
  return new Date(local.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

function parseMatch(match, language) {
  const [, account, balanceRaw, date, directionRaw, sign, amountRaw, contentRaw] = match;
  const direction = language === 'vi'
    ? (directionRaw.toLocaleLowerCase('vi') === 'ghi có' ? 'CREDIT' : 'DEBIT')
    : (directionRaw.toLowerCase() === 'credit' ? 'CREDIT' : 'DEBIT');
  if ((direction === 'CREDIT' && sign !== '+') || (direction === 'DEBIT' && sign !== '-')) {
    throw new AcbParseError('CONFLICTING_DIRECTION');
  }
  const description = contentRaw.trim().replace(/\.$/, '').trim();
  if (description.length > 4000) throw new AcbParseError('DESCRIPTION_TOO_LONG');
  const gdTokens = [...description.matchAll(/\bGD\s+[A-Z0-9]+\b/giu)];
  const gd = /\bGD\s+([A-Z0-9]{6,64})\s+(\d{2})(\d{2})(\d{2})-(\d{2}:\d{2}:\d{2})$/iu.exec(description);
  if (gdTokens.length !== 1 || !gd) throw new AcbParseError('MISSING_GD_IDENTITY');
  const timestampDate = `${gd[2]}/${gd[3]}/20${gd[4]}`;
  if (date !== timestampDate) throw new AcbParseError('CONFLICTING_DATE');
  const amount = money(amountRaw);
  if (amount <= 0) throw new AcbParseError('INVALID_MONEY');
  return {
    account, amount, balance: money(balanceRaw), currency: 'VND', direction,
    occurredAt: parseDate(date, gd[5]), bankReference: `GD:${gd[1].toUpperCase()}:${gd[2]}${gd[3]}${gd[4]}-${gd[5]}`, description,
  };
}

export function parseAcbEmail(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 100_000) throw new AcbParseError('INVALID_BODY');
  const vi = [...text.matchAll(VN)];
  const en = [...text.matchAll(EN)];
  const viMarkers = [...text.matchAll(/ACB trân trọng thông báo tài khoản\b/giu)].length;
  const enMarkers = [...text.matchAll(/ACB respectfully updates your\b/giu)].length;
  if (viMarkers !== vi.length || enMarkers !== en.length || vi.length > 1 || en.length > 1 ||
      (vi.length === 0 && en.length === 0)) throw new AcbParseError('AMBIGUOUS_TEMPLATE');
  const results = [];
  if (vi.length) results.push(parseMatch(vi[0], 'vi'));
  if (en.length) results.push(parseMatch(en[0], 'en'));
  if (results.length === 2 && JSON.stringify(results[0]) !== JSON.stringify(results[1])) throw new AcbParseError('BILINGUAL_CONFLICT');
  return results[0];
}
