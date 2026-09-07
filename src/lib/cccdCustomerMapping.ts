import type { CCCDQrData } from './cccdQrParser';

type CustomerGender = 'Nam' | 'Nữ' | 'Khác' | 'MALE' | 'FEMALE' | 'OTHER';

export type CccdCustomerFields = {
  full_name?: string;
  id_number?: string;
  date_of_birth?: string;
  gender?: CustomerGender;
  id_type: 'CCCD';
  id_issue_date?: string;
  id_issue_place?: string;
  detailed_address?: string;
  permanent_address?: string;
};

const databaseGender: Record<string, 'MALE' | 'FEMALE' | 'OTHER'> = {
  Nam: 'MALE',
  Nữ: 'FEMALE',
  Khác: 'OTHER',
};

function mapGender(
  gender: string,
  format: 'display' | 'database',
): CustomerGender | undefined {
  if (!gender) return undefined;
  if (format === 'database') return databaseGender[gender] ?? 'OTHER';
  return gender === 'Nam' || gender === 'Nữ' || gender === 'Khác' ? gender : 'Khác';
}

export function mapCccdToCustomerFields(
  data: CCCDQrData,
  genderFormat: 'display' | 'database',
): CccdCustomerFields {
  const fields: CccdCustomerFields = { id_type: 'CCCD' };
  const put = <K extends keyof CccdCustomerFields>(key: K, value: CccdCustomerFields[K] | '') => {
    if (value) fields[key] = value;
  };

  put('full_name', data.fullName);
  put('id_number', data.idNumber);
  put('date_of_birth', data.dateOfBirth);
  put('gender', mapGender(data.gender, genderFormat));
  put('id_issue_date', data.idIssueDate);
  if (data.source === 'ocr' && data.ocrReviewApplied) fields.id_issue_date = '';
  put('id_issue_place', data.source === 'ocr' ? 'Cục Cảnh sát' : data.idIssuePlace);
  put('detailed_address', data.permanentAddress);
  put('permanent_address', data.permanentAddress);
  return fields;
}

export function isCurrentCccdScan(
  expectedGeneration: number,
  currentGeneration: number,
  active: boolean,
  customerType: 'INDIVIDUAL' | 'ORGANIZATION',
): boolean {
  return expectedGeneration === currentGeneration && active && customerType === 'INDIVIDUAL';
}

export function bindCccdScanResult<T>(
  expectedGeneration: number,
  getContext: () => {
    generation: number;
    active: boolean;
    customerType: 'INDIVIDUAL' | 'ORGANIZATION';
  },
  apply: (data: T, expectedGeneration: number) => void | Promise<void>,
): (data: T) => void | Promise<void> {
  return (data) => {
    const current = getContext();
    if (!isCurrentCccdScan(
      expectedGeneration,
      current.generation,
      current.active,
      current.customerType,
    )) return;
    return apply(data, expectedGeneration);
  };
}
