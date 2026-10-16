import { describe, expect, it, vi } from 'vitest';
import { mapPayloadToBuildings, type RpcBuilding, type RpcPayload, type RpcRoom } from '@/pages/phong-trong/supabaseData';
import { buildRoomListTable, fmtVndFull, salePolicyLines } from '@/pages/phong-trong/roomListTable';
import { projectAvailableRooms } from '../../../infra/hermes-broker/room-read-projection.mjs';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { storage: { from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: path } }) }) } } }));

// Hermes (crm_available_rooms) and the sale page / "Danh sách phòng trống" image must
// print the same rooms with the same price, status, type, furniture, policy and contact.
// Synthetic data only: names, prices and phone numbers are invented.
const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const building = (n: number, fields: Partial<RpcBuilding> = {}): RpcBuilding => ({ id: uuid(n), name: `Tòa thử ${n}`, code: `T${n}`,
  district: 'Quận Thử', ward: 'Phường 1', address: `${n} Đường Thử, Phường 1, Quận Thử`, total_floors: 5, images: ['PRIVATE_IMAGE'],
  public_contact_name: null, public_contact_phone: null, public_lift_type: 'Thang máy', ...fields });
const room = (n: number, b: number, fields: Partial<RpcRoom> = {}): RpcRoom => ({ id: uuid(n), building_id: uuid(b), floor: 4, name: `40${n % 10}`,
  code: null, area: 20, rent_price: 3_000_000 + n * 100_000, deposit_amount: 3_000_000, max_occupants: 2, amenities: ['Máy lạnh'],
  images: ['PRIVATE_IMAGE'], description: null, sale_note: null, room_type: null, status_public: 'free', sale_state: 'READY',
  sale_today: '2026-10-16', avail_date: null, expected_ready_on: null, pass_contact_name: null, pass_contact_phone: null,
  pass_sale_policy: null, pass_price: null, pass_avail_date: null, pass_contact_manager: false, ...fields });

// get_public_available_rooms payload: 3 vacant + 2 customer-pass rooms listed,
// rented rooms of the same buildings are present but never listed.
const page: RpcPayload = {
  areas: [],
  buildings: [building(1), building(2, { public_contact_name: 'Quản lý riêng', public_contact_phone: '0900000009' }), building(3), building(4), building(5)],
  rooms: [
    room(11, 1, { room_type: 'Gác', sale_note: 'Tặng 1 tháng gửi xe' }), room(12, 1, { status_public: 'rented', sale_state: 'RENTED' }),
    room(21, 2, { amenities: { tu_lanh: true, may_giat: false }, description: 'Mô tả thử' }),
    room(31, 3, { amenities: [], description: 'Phòng mới sơn', status_public: 'soon', sale_state: 'NOTICE', avail_date: '2026-10-25' }),
    room(41, 4, { status_public: 'pass', sale_state: 'PASS', pass_price: 2_700_000, pass_contact_manager: true, pass_sale_policy: 'Khách để lại nội thất' }),
    room(51, 5, { status_public: 'pass', sale_state: 'PASS', pass_price: 2_600_000, pass_contact_phone: '0900000002', pass_contact_name: 'Khách Thử',
      pass_avail_date: '2026-10-20' }),
    room(52, 5, { status_public: 'rented', sale_state: 'RENTED' }),
  ],
  contact: { name: 'Hotline thử', phone: '0900000001' },
  sale_policy: 'Điện 3.800đ/số\nNước 100k/người',
};

// hermes_sale_listing_payload_v1 keeps the page's own rows: same columns, listed
// statuses only, page hotline/policy attached to each building.
function salePageWrapper(payload: RpcPayload) {
  return { pages: 1, buildings: payload.buildings.map(b => ({ id: b.id, name: b.name, code: b.code, district: b.district, ward: b.ward,
    address: b.address, public_contact_name: b.public_contact_name ?? null, public_contact_phone: b.public_contact_phone ?? null,
    public_lift_type: b.public_lift_type ?? null, page_contact_name: payload.contact?.name ?? null, page_contact_phone: payload.contact?.phone ?? null,
    page_sale_policy: payload.sale_policy ?? null })),
  rooms: payload.rooms.filter(r => ['free', 'soon', 'pass'].includes(r.status_public)) };
}

describe('Hermes sale listing = sale page list', () => {
  const table = buildRoomListTable(mapPayloadToBuildings(page));
  const hermes = projectAvailableRooms(salePageWrapper(page), { allowedBuildingIds: page.buildings.map(b => b.id), readAt: Date.parse('2026-10-16T07:00:00Z'), limit: 100 });
  const rows = table.groups.flatMap(group => group.rows);

  it('lists exactly the rooms of the image, including both customer-pass rooms', () => {
    expect(hermes.totalInSnapshot).toBe(table.totalRooms);
    expect(hermes.rooms.map(r => r.id).sort()).toEqual(rows.map(r => r.roomId).sort());
    expect(hermes.rooms.map(r => r.status).sort()).toEqual(['free', 'free', 'pass', 'pass', 'soon']);
  });

  it('prints the same price, status, type, furniture and sale policy cells', () => {
    for (const row of rows) {
      const listed = hermes.rooms.find(r => r.id === row.roomId)!;
      expect(fmtVndFull((listed.priceVnd ?? 0) / 1_000_000)).toBe(row.price);
      expect(listed.statusLines).toEqual(row.status);
      expect(listed.roomType ?? '').toBe(row.type);
      expect(listed.amenities ?? '').toBe(row.amenities);
      expect(listed.salePolicy ?? '').toBe(row.policy);
    }
    const admin = hermes.rooms.find(r => r.id === uuid(41))!, customer = hermes.rooms.find(r => r.id === uuid(51))!;
    expect(admin.statusLines).toEqual(['KHÁCH PASS PHÒNG', 'LIÊN HỆ ADMIN IHOME MỞ CỬA']);
    expect(JSON.stringify(admin)).not.toContain('0900000002');
    expect(customer.statusLines).toEqual(['KHÁCH PASS PHÒNG:', '0900000002 (Khách Thử)']);
    expect(JSON.stringify(hermes)).not.toContain('PRIVATE_IMAGE');
  });

  it('uses the page contact for each building and the page sale policy', () => {
    for (const b of mapPayloadToBuildings(page).filter(value => hermes.buildings.some(h => h.id === value.id))) {
      expect(hermes.buildings.find(h => h.id === b.id)!.contact).toEqual({ name: b.manager || null, phone: b.phone || null });
    }
    expect(salePolicyLines(hermes.salePolicies[0])).toEqual(table.infoLines);
  });
});
