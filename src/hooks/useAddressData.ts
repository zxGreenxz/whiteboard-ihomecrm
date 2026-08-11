import { useQuery } from "@tanstack/react-query";

// =============================================
// Vietnamese Administrative Data Hooks
// Uses provinces.open-api.vn for province/district/ward data
// Requirements: 2.5
// =============================================

interface Province {
  code: number;
  name: string;
}

interface District {
  code: number;
  name: string;
  province_code: number;
}

interface Ward {
  code: number;
  name: string;
  district_code: number;
}

const API_BASE = "https://provinces.open-api.vn/api";

// =============================================
// useProvinces - Load all provinces
// =============================================

export const useProvinces = () => {
  const { data, isLoading } = useQuery({
    queryKey: ["address", "provinces"],
    queryFn: async (): Promise<Province[]> => {
      const res = await fetch(`${API_BASE}/p/`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).map((p: any) => ({
        code: p.code,
        name: p.name,
      }));
    },
    staleTime: Infinity, // Administrative data doesn't change
    gcTime: Infinity,
  });

  return { provinces: data || [], isLoading };
};

// =============================================
// useDistricts - Load districts for a province
// =============================================

// Nhận cả `null`: mã tỉnh/huyện đến từ bản ghi khách hàng, nơi "chưa chọn" là
// `null`. Thân hàm đã có `if (!provinceCode) return []` nên `null` chạy y hệt
// `undefined` — kiểu chỉ đang mô tả hẹp hơn thực tế.
export const useDistricts = (provinceCode?: string | null) => {
  const { data, isLoading } = useQuery({
    queryKey: ["address", "districts", provinceCode],
    queryFn: async (): Promise<District[]> => {
      if (!provinceCode) return [];
      const res = await fetch(`${API_BASE}/p/${provinceCode}?depth=2`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.districts || []).map((d: any) => ({
        code: d.code,
        name: d.name,
        province_code: d.province_code,
      }));
    },
    enabled: !!provinceCode,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return { districts: data || [], isLoading };
};

// =============================================
// useWards - Load wards for a district
// =============================================

export const useWards = (districtCode?: string | null) => {
  const { data, isLoading } = useQuery({
    queryKey: ["address", "wards", districtCode],
    queryFn: async (): Promise<Ward[]> => {
      if (!districtCode) return [];
      const res = await fetch(`${API_BASE}/d/${districtCode}?depth=2`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.wards || []).map((w: any) => ({
        code: w.code,
        name: w.name,
        district_code: w.district_code,
      }));
    },
    enabled: !!districtCode,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  return { wards: data || [], isLoading };
};
