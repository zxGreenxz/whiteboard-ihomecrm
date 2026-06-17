// Kiểu dùng chung giữa ContractDetailPage (desktop) và nhánh mobile.
// (Tách ra để page + các tab mobile cùng 1 nguồn type, không khai trùng.)

export interface ContractServiceItem {
  id: string;
  service_id: string;
  unit_price: number;
  initial_reading: number | null;
  service: {
    id: string;
    name: string;
    type: string;
    unit: string;
  };
}

export interface ContractHistoryItem {
  id: string;
  type: 'extension' | 'transfer' | 'termination';
  created_at: string;
  status: string;
  details: Record<string, any>;
}

export interface ContractVehicle {
  id: string;
  customer_id: string;
  vehicle_type: string | null;
  vehicle_name: string | null;
  brand: string | null;
  model: string | null;
  license_plate: string | null;
  color: string | null;
  parking_fee: number | null;
}
