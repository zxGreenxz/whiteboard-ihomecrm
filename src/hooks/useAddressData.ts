import { useQuery } from '@tanstack/react-query';
export interface Province {
  code: number;
  name: string;
}
export interface District {
  code: number;
  name: string;
  province_code: number;
}
export interface Ward {
  code: number;
  name: string;
  district_code: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseNamedCodes(value: unknown): Array<{ code: number; name: string }> {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isRecord(item) && typeof item.code === 'number' && typeof item.name === 'string',
    )
  ) {
    throw new Error('Dữ liệu địa chỉ không hợp lệ');
  }
  return value.map((item) => ({ code: item.code as number, name: item.name as string }));
}

function parseProvinces(value: unknown): Province[] {
  return parseNamedCodes(value);
}

function parseDistricts(value: unknown): District[] {
  if (!isRecord(value) || !Array.isArray(value.districts)) {
    throw new Error('Dữ liệu địa chỉ không hợp lệ');
  }
  const districts = value.districts;
  const base = parseNamedCodes(districts);
  if (
    !districts.every(
      (item) => isRecord(item) && typeof item.province_code === 'number',
    )
  ) {
    throw new Error('Dữ liệu địa chỉ không hợp lệ');
  }
  return base.map((item, index) => ({
    ...item,
    province_code: (districts[index] as Record<string, unknown>).province_code as number,
  }));
}

function parseWards(value: unknown): Ward[] {
  if (!isRecord(value) || !Array.isArray(value.wards)) {
    throw new Error('Dữ liệu địa chỉ không hợp lệ');
  }
  const wards = value.wards;
  const base = parseNamedCodes(wards);
  if (
    !wards.every(
      (item) => isRecord(item) && typeof item.district_code === 'number',
    )
  ) {
    throw new Error('Dữ liệu địa chỉ không hợp lệ');
  }
  return base.map((item, index) => ({
    ...item,
    district_code: (wards[index] as Record<string, unknown>).district_code as number,
  }));
}

const API_BASE = 'https://provinces.open-api.vn/api';

async function requestJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  if (!response.ok) {
    throw new Error(`Không thể tải dữ liệu địa chỉ (${response.status})`);
  }
  return response.json() as Promise<unknown>;
}

export const useProvinces = () => {
  const query = useQuery<Province[], Error>({
    queryKey: ['address', 'provinces'],
    queryFn: async ({ signal }) => parseProvinces(await requestJson('/p/', signal)),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return {
    provinces: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    retry: query.refetch,
  };
};

export const useDistricts = (provinceCode?: string | null) => {
  const query = useQuery<District[], Error>({
    queryKey: ['address', 'districts', provinceCode],
    queryFn: async ({ signal }) => {
      const payload = await requestJson(`/p/${provinceCode}?depth=2`, signal);
      return parseDistricts(payload);
    },
    enabled: Boolean(provinceCode),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return {
    districts: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    retry: query.refetch,
  };
};

export const useWards = (districtCode?: string | null) => {
  const query = useQuery<Ward[], Error>({
    queryKey: ['address', 'wards', districtCode],
    queryFn: async ({ signal }) => {
      const payload = await requestJson(`/d/${districtCode}?depth=2`, signal);
      return parseWards(payload);
    },
    enabled: Boolean(districtCode),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return {
    wards: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    retry: query.refetch,
  };
};
