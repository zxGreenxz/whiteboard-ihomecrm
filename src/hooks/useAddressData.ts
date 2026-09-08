import { useQuery } from '@tanstack/react-query';
export interface Province { code: number; name: string }
export interface District { code: number; name: string; province_code: number }
export interface Ward { code: number; name: string; district_code: number }
const API_BASE = 'https://provinces.open-api.vn/api';
async function requestJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { signal });
  if (!response.ok) throw new Error(`Không thể tải dữ liệu địa chỉ (${response.status})`);
  return response.json() as Promise<T>;
}
export const useProvinces = () => {
  const q = useQuery<Province[], Error>({ queryKey: ['address', 'provinces'], queryFn: async ({ signal }) => {
    const data = await requestJson<Province[]>('/p/', signal);
    return data.map(({ code, name }) => ({ code, name }));
  }, staleTime: Infinity, gcTime: Infinity });
  return { provinces: q.data ?? [], isLoading: q.isLoading, error: q.error, retry: q.refetch };
};
export const useDistricts = (provinceCode?: string | null) => {
  const q = useQuery<District[], Error>({ queryKey: ['address', 'districts', provinceCode], queryFn: async ({ signal }) => {
    const data = await requestJson<{ districts?: District[] }>(`/p/${provinceCode}?depth=2`, signal);
    return (data.districts ?? []).map(({ code, name, province_code }) => ({ code, name, province_code }));
  }, enabled: Boolean(provinceCode), staleTime: Infinity, gcTime: Infinity });
  return { districts: q.data ?? [], isLoading: q.isLoading, error: q.error, retry: q.refetch };
};
export const useWards = (districtCode?: string | null) => {
  const q = useQuery<Ward[], Error>({ queryKey: ['address', 'wards', districtCode], queryFn: async ({ signal }) => {
    const data = await requestJson<{ wards?: Ward[] }>(`/d/${districtCode}?depth=2`, signal);
    return (data.wards ?? []).map(({ code, name, district_code }) => ({ code, name, district_code }));
  }, enabled: Boolean(districtCode), staleTime: Infinity, gcTime: Infinity });
  return { wards: q.data ?? [], isLoading: q.isLoading, error: q.error, retry: q.refetch };
};
