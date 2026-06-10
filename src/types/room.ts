export type RoomStatus = 'AVAILABLE' | 'OCCUPIED' | 'RESERVED' | 'MAINTENANCE' | 'UNAVAILABLE';

export interface Room {
  id: string;
  building_id: string;
  name: string;
  code: string | null;
  floor: number;
  status: RoomStatus;
  area: number | null;
  max_occupants: number | null;
  rent_price: number;
  deposit_amount: number;
  description: string | null;
  images: any;
  amenities: any;
  invoice_template_id: string | null;
  lease_template_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RoomWithRelations extends Room {
  building?: {
    id: string;
    name: string;
    code: string | null;
  } | null;
}

export interface RoomFormData {
  building_id: string;
  floor: number;
  name: string;
  rent_price: number;
  deposit_amount: number;
  area?: number | null;
  max_occupants?: number | null;
  status: RoomStatus;
  invoice_template_id?: string | null;
  lease_template_id?: string | null;
}
