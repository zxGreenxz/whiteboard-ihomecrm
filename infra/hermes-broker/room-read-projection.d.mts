export interface ProjectAvailableRoomsOptions {
  allowedBuildingIds: string[];
  buildingName?: string;
  offset?: number;
  limit?: number;
  readAt: number;
}
export interface HermesSaleListingRoom {
  id: string;
  code: string | null;
  name: string;
  building: { id: string; name: string; code: string | null };
  floor: number | null;
  areaM2: number | null;
  priceVnd: number | null;
  rentVnd: number | null;
  depositVnd: number | null;
  status: 'free' | 'soon' | 'pass';
  availability: { kind: string; label: string; availableOn: string | null };
  statusLines: string[];
  roomType: string | null;
  amenities: string | null;
  salePolicy: string | null;
}
export interface HermesSaleListing {
  source: 'hermes_sale_listing_rooms_v1';
  readAt: string;
  currency: 'VND';
  completeness: 'complete' | 'source_capped';
  listing: 'published' | 'no_sale_page';
  notice: string | null;
  publishedPages: number;
  totalInSnapshot: number;
  offset: number;
  nextOffset: number | null;
  salePolicies: string[];
  buildings: { id: string; name: string; code: string | null; address: string | null; contact: { name: string | null; phone: string | null } }[];
  rooms: HermesSaleListingRoom[];
}
export const PASS_CONTACT_CHARS: number;
export const NO_SALE_PAGE_NOTICE: string;
export function projectAvailableRooms(payload: unknown, options: ProjectAvailableRoomsOptions): HermesSaleListing;
