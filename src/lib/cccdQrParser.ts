import type { Candidate } from './qr/types';

export interface CCCDQrData {
  source?: 'qr' | 'ocr';
  /** Only the explicit complete OCR review/apply action sets this intent. */
  ocrReviewApplied?: true;
  idNumber: string;
  fullName: string;
  dateOfBirth: string;
  gender: string;
  permanentAddress: string;
  idIssueDate: string;
  idIssuePlace: string;
}

export type CccdQrValidation =
  | { status: 'valid'; data: CCCDQrData }
  | { status: 'invalid' };

export type CccdCandidateSelection =
  | { status: 'valid'; data: CCCDQrData }
  | { status: 'invalid' | 'ambiguous' };

const SUPPORTED_FIELD_COUNTS = new Set([7, 11]);

function parseCccdDate(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  const day = Number(raw.slice(0, 2));
  const month = Number(raw.slice(2, 4));
  const year = Number(raw.slice(4, 8));
  if (year === 0 || month === 0 || day === 0) return null;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;

  return `${raw.slice(4, 8)}-${raw.slice(2, 4)}-${raw.slice(0, 2)}`;
}

function normalizeGender(raw: string): string | null {
  const normalized = raw.toLocaleLowerCase('vi');
  if (normalized === 'male' || normalized === 'nam' || normalized === 'm') return 'Nam';
  if (normalized === 'female' || normalized === 'nữ' || normalized === 'nu' || normalized === 'f') return 'Nữ';
  return null;
}

/** Validate a decoded payload without repairing or normalizing its identity fields. */
export function validateCccdQr(raw: string): CccdQrValidation {
  const payload = raw.trim();
  if (!payload) return { status: 'invalid' };

  const parts = payload.split('|');
  if (!SUPPORTED_FIELD_COUNTS.has(parts.length)) return { status: 'invalid' };

  const [idNumber, , fullName, dobRaw, genderRaw, permanentAddress, issueRaw] = parts;
  if (!/^\d{12}$/.test(idNumber)) return { status: 'invalid' };
  if (!fullName || !fullName.trim() || !permanentAddress || !permanentAddress.trim()) {
    return { status: 'invalid' };
  }

  const dateOfBirth = parseCccdDate(dobRaw);
  const idIssueDate = parseCccdDate(issueRaw);
  const gender = normalizeGender(genderRaw);
  if (!dateOfBirth || !idIssueDate || !gender) return { status: 'invalid' };

  return {
    status: 'valid',
    data: {
      idNumber,
      fullName,
      dateOfBirth,
      gender,
      permanentAddress,
      idIssueDate,
      idIssuePlace: 'Cục Cảnh Sát',
    },
  };
}

/** Select one unique valid CCCD and never choose arbitrarily between identities. */
export function selectCccdCandidate(candidates: Candidate[]): CccdCandidateSelection {
  const validByIdentity = new Map<string, CCCDQrData>();
  for (const candidate of candidates) {
    const validation = validateCccdQr(candidate.text);
    if (validation.status === 'valid') {
      validByIdentity.set(JSON.stringify(validation.data), validation.data);
    }
  }
  if (validByIdentity.size === 0) return { status: 'invalid' };
  if (validByIdentity.size > 1) return { status: 'ambiguous' };
  return { status: 'valid', data: validByIdentity.values().next().value! };
}

/** Compatibility adapter for the current camera consumer. */
export function parseCccdQr(raw: string | null | undefined): CCCDQrData | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const result = validateCccdQr(raw);
  if (result.status === 'valid') return result.data;
  throw new Error('Chuỗi QR không đúng định dạng CCCD');
}
