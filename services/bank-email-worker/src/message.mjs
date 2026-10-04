import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { promises as dns } from 'node:dns';
import { simpleParser } from 'mailparser';
import { convert } from 'html-to-text';
import { parseAcbEmail, AcbParseError } from './parser.mjs';

export class MessageVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MessageVerificationError';
    this.code = code;
  }
}

const MAX_RAW_BYTES = 512 * 1024;
const MAX_SIGNATURES = 4;
const REQUIRED_SIGNED = ['from', 'mime-version', 'content-type'];
const OPTIONAL_CRITICAL_SIGNED = ['content-transfer-encoding', 'subject', 'reply-to'];

function rawHeaderFields(raw) {
  const split = raw.indexOf(Buffer.from('\r\n\r\n'));
  if (split < 0 || split > 64 * 1024) throw new MessageVerificationError('INVALID_HEADERS');
  const lines = raw.subarray(0, split).toString('latin1').split('\r\n');
  const fields = new Map();
  for (const line of lines) {
    if (/^[ \t]/u.test(line)) continue;
    const match = /^([!-9;-~]+):/u.exec(line);
    if (!match) throw new MessageVerificationError('INVALID_HEADERS');
    const key = match[1].toLowerCase();
    fields.set(key, (fields.get(key) ?? 0) + 1);
  }
  return fields;
}

function extractBody(mail) {
  if (mail.attachments?.length) throw new MessageVerificationError('ATTACHMENTS_UNSUPPORTED');
  if (typeof mail.text === 'string' && mail.text.length > 0 && mail.text.length <= 100_000) {
    const plain = mail.text;
    if (typeof mail.html === 'string' && mail.html.length) {
      const htmlText = convert(mail.html, { wordwrap: false,
        selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] });
      const plainParsed = parseAcbEmail(plain);
      const htmlParsed = parseAcbEmail(htmlText);
      if (JSON.stringify(plainParsed) !== JSON.stringify(htmlParsed)) throw new MessageVerificationError('MIME_BODY_CONFLICT');
    }
    return plain;
  }
  if (typeof mail.html === 'string' && mail.html.length <= 100_000) {
    return convert(mail.html, { wordwrap: false,
      selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }] });
  }
  throw new MessageVerificationError('NO_TEXT_BODY');
}

export async function verifyAcbMessage(rawInput, {
  resolver = (name, type) => dns.resolve(name, type), dnsTimeoutMs = 5000, verificationTimeoutMs = 10_000,
} = {}) {
  const raw = Buffer.isBuffer(rawInput) ? rawInput : Buffer.from(rawInput ?? '');
  if (raw.length === 0 || raw.length > MAX_RAW_BYTES) throw new MessageVerificationError('RAW_SIZE_LIMIT');
  const fields = rawHeaderFields(raw);
  for (const header of REQUIRED_SIGNED) {
    if (fields.get(header) !== 1) throw new MessageVerificationError('UNSAFE_MIME_HEADERS');
  }
  if (OPTIONAL_CRITICAL_SIGNED.some(header => (fields.get(header) ?? 0) > 1)) {
    throw new MessageVerificationError('DUPLICATE_HEADERS');
  }
  const signatureCount = ['dkim-signature', 'arc-message-signature', 'arc-seal']
    .reduce((count, header) => count + (fields.get(header) ?? 0), 0);
  if (signatureCount > MAX_SIGNATURES) throw new MessageVerificationError('DKIM_SIGNATURE_LIMIT');
  const deadline = performance.now() + verificationTimeoutMs;
  let budgetExhausted = false;
  const boundedResolver = (name, type) => {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      budgetExhausted = true;
      return Promise.reject(new MessageVerificationError('DKIM_VERIFY_TIMEOUT'));
    }
    const totalBudgetTimer = remainingMs <= dnsTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (totalBudgetTimer) budgetExhausted = true;
        reject(new MessageVerificationError(totalBudgetTimer ? 'DKIM_VERIFY_TIMEOUT' : 'DKIM_DNS_TIMEOUT'));
      }, Math.min(dnsTimeoutMs, remainingMs));
      Promise.resolve().then(() => resolver(name, type)).then(
        result => { clearTimeout(timer); resolve(result); },
        error => { clearTimeout(timer); reject(error); },
      );
    });
  };
  let verification;
  try {
    verification = await dkimVerify(raw, { resolver: boundedResolver, strict: true, minBitLength: 2048 });
  } catch (error) {
    if (budgetExhausted || performance.now() >= deadline) throw new MessageVerificationError('DKIM_VERIFY_TIMEOUT');
    throw error;
  }
  if (budgetExhausted || performance.now() >= deadline) throw new MessageVerificationError('DKIM_VERIFY_TIMEOUT');
  if (verification.fromFields !== 1) throw new MessageVerificationError('MULTIPLE_FROM_FIELDS');
  const valid = verification.results?.some(result => {
    if (result.status?.result !== 'pass' || result.signingDomain?.toLowerCase() !== 'acb.com.vn' ||
        result.canonBodyLengthLimited || result.status?.testing || result.status?.warnings?.length) return false;
    const signed = new Set((result.signingHeaders?.keys ?? '').toLowerCase().split(/:\s*/u));
    return REQUIRED_SIGNED.every(header => signed.has(header)) &&
      OPTIONAL_CRITICAL_SIGNED.filter(key => fields.has(key)).every(key => signed.has(key));
  });
  if (!valid) throw new MessageVerificationError('DKIM_UNVERIFIED');
  const mail = await simpleParser(raw, {
    skipTextToHtml: true, skipHtmlToText: true, skipImageLinks: true,
    maxHtmlLengthToParse: 100_000,
  });
  if (mail.from?.value?.length !== 1 || mail.from.value[0].address?.toLowerCase() !== 'mailalert@acb.com.vn') {
    throw new MessageVerificationError('INVALID_SENDER');
  }
  let parsed;
  try {
    parsed = parseAcbEmail(extractBody(mail));
  } catch (error) {
    if (error instanceof AcbParseError) throw error;
    throw error;
  }
  return { parsed };
}
