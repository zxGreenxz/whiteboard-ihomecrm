// Test tự động cho 2 RPC Báo cáo Lấp đầy v2 (Phase 8):
//   occupancy_snapshot_v2(p_as_of_date, p_building_ids)
//   occupancy_upcoming_vacancy_v2(p_as_of_date, p_window_days, p_building_ids)
//
// Dựng fixture TỔNG HỢP trong 1 transaction ROLLBACK (không đụng dữ liệu thật),
// impersonate owner X qua RLS thật, khẳng định:
//   1. CÁCH LY TENANT: X không thấy toà Y; p_building_ids=[toà Y] → 0 dòng (cả 2 RPC)
//   2. PHÂN LOẠI 5 nhóm + INVARIANT total = Σ nhóm; RESERVED không vào available;
//      MAINTENANCE/UNAVAILABLE/RESERVED không vào missed_revenue; trạng thái
//      OCCUPIED mồ côi HĐ → unavailable (KHÔNG vào available)
//   3. BOUNDARY sắp trống: HĐ hết hạn đúng 0/30/31/60 ngày — cửa sổ 30 lấy {0,30},
//      cửa sổ 60 lấy đủ 4
//   4. EXTENSION: COMPLETED/APPROVED đẩy effective_end (rớt khỏi bucket);
//      DRAFT không có hiệu lực; nhiều extension lấy ngày hợp lệ XA NHẤT
//   5. HĐ CHỒNG NHAU 1 phòng → distinct 1 dòng (lấy end xa nhất)
//   6. Toà 0 phòng → total 0, pct 0 (không NaN)
//   7. >1000 phòng → total ĐỦ 1100 (không cap-1000)
//
// Chạy: node scripts/test-occupancy-v2.mjs   (exit 0 = PASS, 1 = FAIL)
import { readFileSync } from 'node:fs';

let pat = process.env.SUPABASE_PAT;
if (!pat) {
  try {
    const local = readFileSync(new URL('../CLAUDE.local.md', import.meta.url), 'utf8');
    const m = local.match(/sbp_[a-f0-9]+/);
    if (m) pat = m[0];
  } catch {}
}
if (!pat) { console.error('Không tìm thấy PAT (env SUPABASE_PAT hoặc CLAUDE.local.md)'); process.exit(1); }
const ref = process.env.SUPABASE_PROJECT_REF || 'tryymsxyyckgbrmmvozx';

const AS_OF = '2030-01-01'; // ngày cố định để boundary deterministic

// UUID tổng hợp — 3x = tenant X, 4x = tenant Y (khác dải test-cross-tenant).
const ID = {
  ownerX: '33333333-0000-4000-8000-000000000001',
  ownerY: '44444444-0000-4000-8000-000000000001',
  b1: '33333333-0000-4000-8000-0000000000b1', // toà boundary/extension/overlap
  b2: '33333333-0000-4000-8000-0000000000b2', // toà phân loại 5 nhóm
  b3: '33333333-0000-4000-8000-0000000000b3', // toà 1100 phòng
  b4: '33333333-0000-4000-8000-0000000000b4', // toà 0 phòng
  bY: '44444444-0000-4000-8000-0000000000b9', // toà tenant Y
};

const FIXTURE = `
  SET LOCAL session_replication_role = replica;
  -- Mô hình visibility của repo: owner thấy toà qua staff_assignments FULL-SCOPE
  -- (building_id NULL, area_id NULL) dưới chính mình — KHÔNG có nhánh
  -- b.user_id=auth.uid() trong accessible_building_ids/can_access_building.
  INSERT INTO public.roles (id,user_id,name,permissions) VALUES
    ('33333333-0000-4000-8000-0000000000c1','${ID.ownerX}','Chủ nhà','{}'::jsonb);
  INSERT INTO public.staff_assignments (id,staff_id,user_id,role_id,building_id,area_id) VALUES
    ('33333333-0000-4000-8000-0000000000c2','${ID.ownerX}','${ID.ownerX}','33333333-0000-4000-8000-0000000000c1',NULL,NULL);
  INSERT INTO public.buildings (id,user_id,name,province,district,ward,total_floors,total_rooms) VALUES
    ('${ID.b1}','${ID.ownerX}','OV2-B1','P','D','W',1,1),
    ('${ID.b2}','${ID.ownerX}','OV2-B2','P','D','W',1,1),
    ('${ID.b3}','${ID.ownerX}','OV2-B3','P','D','W',1,1),
    ('${ID.b4}','${ID.ownerX}','OV2-B4','P','D','W',1,1),
    ('${ID.bY}','${ID.ownerY}','OV2-BY','P','D','W',1,1);

  -- B1: 8 phòng cho boundary/extension/overlap (đều đang occupied)
  INSERT INTO public.rooms (id,building_id,name,rent_price,deposit_amount,floor,max_occupants,status)
  SELECT ('33333333-0000-4000-8000-0000000000d'||i)::uuid, '${ID.b1}', 'B1R'||i, 2000000, 0, 1, 1, 'OCCUPIED'
  FROM generate_series(1,8) i;

  -- HĐ boundary: hết hạn đúng +0/+30/+31/+60 ngày so với AS_OF
  INSERT INTO public.contracts (id,user_id,room_id,signed_date,start_date,end_date,rent_price,public_code,status) VALUES
    ('33333333-0000-4000-8000-0000000000e1','${ID.ownerX}','33333333-0000-4000-8000-0000000000d1','2029-01-01','2029-01-01','2030-01-01',2000000,'OV2C1','ACTIVE'),
    ('33333333-0000-4000-8000-0000000000e2','${ID.ownerX}','33333333-0000-4000-8000-0000000000d2','2029-01-01','2029-01-01','2030-01-31',2000000,'OV2C2','ACTIVE'),
    ('33333333-0000-4000-8000-0000000000e3','${ID.ownerX}','33333333-0000-4000-8000-0000000000d3','2029-01-01','2029-01-01','2030-02-01',2000000,'OV2C3','ACTIVE'),
    ('33333333-0000-4000-8000-0000000000e4','${ID.ownerX}','33333333-0000-4000-8000-0000000000d4','2029-01-01','2029-01-01','2030-03-02',2000000,'OV2C4','ACTIVE');

  -- Extension: C5 hết 2030-01-15 (14d) nhưng có APPROVED→2030-03-01 và
  -- COMPLETED→2030-06-30 (lấy xa nhất → rớt cả 2 cửa sổ); C6 hết 2030-01-20
  -- (19d) chỉ có DRAFT + CANCELLED → vẫn trong bucket 30.
  INSERT INTO public.contracts (id,user_id,room_id,signed_date,start_date,end_date,rent_price,public_code,status) VALUES
    ('33333333-0000-4000-8000-0000000000e5','${ID.ownerX}','33333333-0000-4000-8000-0000000000d5','2029-01-01','2029-01-01','2030-01-15',2000000,'OV2C5','ACTIVE'),
    ('33333333-0000-4000-8000-0000000000e6','${ID.ownerX}','33333333-0000-4000-8000-0000000000d6','2029-01-01','2029-01-01','2030-01-20',2000000,'OV2C6','ACTIVE');
  INSERT INTO public.contract_extensions (id,contract_id,user_id,extension_months,extension_type,extension_date,old_end_date,new_end_date,status) VALUES
    ('33333333-0000-4000-8000-0000000000f1','33333333-0000-4000-8000-0000000000e5','${ID.ownerX}',2,'UPDATE_EXISTING','2029-12-01','2030-01-15','2030-03-01','APPROVED'),
    ('33333333-0000-4000-8000-0000000000f2','33333333-0000-4000-8000-0000000000e5','${ID.ownerX}',5,'UPDATE_EXISTING','2029-12-15','2030-01-15','2030-06-30','COMPLETED'),
    ('33333333-0000-4000-8000-0000000000f3','33333333-0000-4000-8000-0000000000e6','${ID.ownerX}',6,'UPDATE_EXISTING','2029-12-01','2030-01-20','2030-07-20','DRAFT'),
    ('33333333-0000-4000-8000-0000000000f4','33333333-0000-4000-8000-0000000000e6','${ID.ownerX}',6,'UPDATE_EXISTING','2029-12-02','2030-01-20','2030-08-20','CANCELLED');

  -- Overlap: phòng D7 có 2 HĐ ACTIVE chồng nhau (end 2030-01-10 và 2030-02-20)
  -- → distinct 1 dòng, lấy end xa nhất 2030-02-20 (50d)
  INSERT INTO public.contracts (id,user_id,room_id,signed_date,start_date,end_date,rent_price,public_code,status) VALUES
    ('33333333-0000-4000-8000-0000000000e7','${ID.ownerX}','33333333-0000-4000-8000-0000000000d7','2029-01-01','2029-01-01','2030-01-10',2000000,'OV2C7','ACTIVE'),
    ('33333333-0000-4000-8000-0000000000e8','${ID.ownerX}','33333333-0000-4000-8000-0000000000d7','2029-06-01','2029-06-01','2030-02-20',2000000,'OV2C8','ACTIVE');
  -- D8 để trống HĐ → OCCUPIED mồ côi (đếm vào B1.unavailable, không available)

  -- B2: phân loại 5 nhóm — RESERVED / MAINTENANCE / UNAVAILABLE / AVAILABLE(5tr) / AVAILABLE(3tr)
  INSERT INTO public.rooms (id,building_id,name,rent_price,deposit_amount,floor,max_occupants,status) VALUES
    ('33333333-0000-4000-8000-0000000000a1','${ID.b2}','B2R1',9000000,0,1,1,'RESERVED'),
    ('33333333-0000-4000-8000-0000000000a2','${ID.b2}','B2R2',8000000,0,1,1,'MAINTENANCE'),
    ('33333333-0000-4000-8000-0000000000a3','${ID.b2}','B2R3',7000000,0,1,1,'UNAVAILABLE'),
    ('33333333-0000-4000-8000-0000000000a4','${ID.b2}','B2R4',5000000,0,1,1,'AVAILABLE'),
    ('33333333-0000-4000-8000-0000000000a5','${ID.b2}','B2R5',3000000,0,1,1,'AVAILABLE');

  -- B3: 1100 phòng AVAILABLE 1tr — chứng minh không cap-1000
  INSERT INTO public.rooms (id,building_id,name,rent_price,deposit_amount,floor,max_occupants,status)
  SELECT gen_random_uuid(), '${ID.b3}', 'B3R'||i, 1000000, 0, 1, 1, 'AVAILABLE'
  FROM generate_series(1,1100) i;

  -- BY: tenant Y — 1 phòng occupied, X KHÔNG được thấy
  INSERT INTO public.rooms (id,building_id,name,rent_price,deposit_amount,floor,max_occupants,status) VALUES
    ('44444444-0000-4000-8000-0000000000a9','${ID.bY}','BYR1',2000000,0,1,1,'OCCUPIED');
  INSERT INTO public.contracts (id,user_id,room_id,signed_date,start_date,end_date,rent_price,public_code,status) VALUES
    ('44444444-0000-4000-8000-0000000000e9','${ID.ownerY}','44444444-0000-4000-8000-0000000000a9','2029-01-01','2029-01-01','2030-01-05',2000000,'OV2CY','ACTIVE');
`;

async function apiQuery(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

const IMPERSONATE_X = `
  SET LOCAL ROLE authenticated;
  SELECT set_config('request.jwt.claims',
    json_build_object('sub','${ID.ownerX}','role','authenticated')::text, true);
`;

async function probe() {
  const sql = `BEGIN;
${FIXTURE}
${IMPERSONATE_X}
  SELECT json_build_object(
    'snap', (SELECT json_agg(json_build_object(
        'name', building_name, 'total', total, 'occupied', occupied,
        'reserved', reserved, 'maintenance', maintenance,
        'unavailable', unavailable, 'available', available,
        'occ_pct', occupancy_pct, 'com_pct', committed_pct,
        'missed', missed_revenue) ORDER BY building_name)
      FROM public.occupancy_snapshot_v2('${AS_OF}',
        ARRAY['${ID.b1}','${ID.b2}','${ID.b3}','${ID.b4}','${ID.bY}']::uuid[])),
    'invariant_bad', (SELECT count(*) FROM public.occupancy_snapshot_v2('${AS_OF}', NULL)
      WHERE total <> occupied + reserved + maintenance + unavailable + available),
    'snap_only_Y', (SELECT count(*) FROM public.occupancy_snapshot_v2('${AS_OF}', ARRAY['${ID.bY}']::uuid[])),
    'vac30', (SELECT json_agg(room_name ORDER BY room_name)
      FROM public.occupancy_upcoming_vacancy_v2('${AS_OF}', 30, ARRAY['${ID.b1}']::uuid[])),
    'vac60', (SELECT json_agg(json_build_object('room', room_name, 'days', days_remaining, 'ext', extension_applied) ORDER BY room_name)
      FROM public.occupancy_upcoming_vacancy_v2('${AS_OF}', 60, ARRAY['${ID.b1}']::uuid[])),
    'vac_dup', (SELECT count(*) FROM (
      SELECT room_id FROM public.occupancy_upcoming_vacancy_v2('${AS_OF}', 400, NULL)
      GROUP BY room_id HAVING count(*) > 1) d),
    'vac_only_Y', (SELECT count(*) FROM public.occupancy_upcoming_vacancy_v2('${AS_OF}', 60, ARRAY['${ID.bY}']::uuid[]))
  ) AS verdict;
ROLLBACK;`;
  const { ok, body } = await apiQuery(sql);
  if (!ok) return { error: body.slice(0, 600) };
  try { return JSON.parse(body)[0]?.verdict ?? { error: 'no verdict' }; }
  catch { return { error: 'parse fail', raw: body.slice(0, 300) }; }
}

function fail(msg, extra) {
  console.error(`❌ ${msg}`); if (extra !== undefined) console.error('   ', JSON.stringify(extra));
  process.exitCode = 1;
}
function pass(msg) { console.log(`✅ ${msg}`); }

const v = await probe();
if (v.error) { console.error('Lỗi chạy probe:', v.error); process.exit(1); }

// 1. Cách ly tenant
const names = (v.snap ?? []).map(s => s.name);
if (names.includes('OV2-BY')) fail('X THẤY toà của Y trong snapshot', names);
else pass('Snapshot không lộ toà tenant Y (dù truyền id trong p_building_ids)');
if (v.snap_only_Y === 0) pass('p_building_ids=[toà Y] → 0 dòng snapshot');
else fail(`p_building_ids=[toà Y] phải 0 dòng, được ${v.snap_only_Y}`);
if (v.vac_only_Y === 0) pass('p_building_ids=[toà Y] → 0 dòng upcoming vacancy');
else fail(`vacancy toà Y phải 0 dòng, được ${v.vac_only_Y}`);

// 2. Phân loại + invariant
const by = Object.fromEntries((v.snap ?? []).map(s => [s.name, s]));
const b1 = by['OV2-B1'], b2 = by['OV2-B2'], b3 = by['OV2-B3'], b4 = by['OV2-B4'];
if (v.invariant_bad === 0) pass('Invariant total = Σ 5 nhóm trên MỌI toà thấy được');
else fail(`${v.invariant_bad} toà vi phạm invariant`);
if (b1 && b1.total === 8 && b1.occupied === 7 && b1.unavailable === 1 && b1.available === 0)
  pass('B1: 7 occupied + 1 OCCUPIED-mồ-côi → unavailable (không vào available)');
else fail('B1 phân loại sai', b1);
if (b2 && b2.total === 5 && b2.reserved === 1 && b2.maintenance === 1 && b2.unavailable === 1
    && b2.available === 2 && Number(b2.missed) === 8000000)
  pass('B2: RESERVED/MAINT/UNAVAIL tách riêng; missed_revenue CHỈ 2 phòng AVAILABLE (8tr)');
else fail('B2 phân loại/missed sai', b2);
if (b2 && Number(b2.occ_pct) === 0 && Number(b2.com_pct) === 20)
  pass('B2: occupancy 0%, committed 20% (1 reserved / 5)');
else fail('B2 pct sai', b2);
if (b3 && b3.total === 1100 && Number(b3.missed) === 1100000000)
  pass('B3: 1100 phòng đếm ĐỦ (không cap-1000), missed 1,1 tỷ');
else fail('B3 cap-1000 hoặc missed sai', b3);
if (b4 && b4.total === 0 && Number(b4.occ_pct) === 0 && Number(b4.com_pct) === 0)
  pass('B4: toà 0 phòng → total 0, pct 0 (không NaN)');
else fail('B4 sai', b4);

// 3. Boundary + extension + overlap (cửa sổ 30 và 60, toà B1)
const vac30 = v.vac30 ?? [];
const exp30 = ['B1R1', 'B1R2', 'B1R6']; // +0d, +30d, C6 19d (DRAFT/CANCELLED không đẩy)
if (JSON.stringify(vac30) === JSON.stringify(exp30))
  pass('Cửa sổ 30: đúng {0d, 30d, 19d-DRAFT-không-hiệu-lực}; 31d/60d/extension-COMPLETED bị loại');
else fail('Cửa sổ 30 sai', { got: vac30, expected: exp30 });
const vac60 = v.vac60 ?? [];
const rooms60 = vac60.map(r => r.room);
const exp60 = ['B1R1', 'B1R2', 'B1R3', 'B1R4', 'B1R6', 'B1R7'];
if (JSON.stringify(rooms60) === JSON.stringify(exp60))
  pass('Cửa sổ 60: đủ {0,30,31,60,19,50(overlap)}; C5 (ext COMPLETED→180d) bị loại');
else fail('Cửa sổ 60 sai', { got: rooms60, expected: exp60 });
const d7 = vac60.find(r => r.room === 'B1R7');
if (d7 && d7.days === 50) pass('Overlap: phòng 2 HĐ → 1 dòng, lấy end XA NHẤT (50d)');
else fail('Overlap sai', d7);
const d6 = vac60.find(r => r.room === 'B1R6');
if (d6 && d6.ext === false) pass('extension_applied=false khi chỉ có DRAFT/CANCELLED');
else fail('extension_applied sai cho C6', d6);
if (v.vac_dup === 0) pass('Không phòng nào xuất hiện 2 lần (cửa sổ rộng 400d)');
else fail(`${v.vac_dup} phòng bị trùng dòng`);

console.log(process.exitCode ? '\n=== ❌ OCCUPANCY V2 FAIL ===' : '\n=== ✅ OCCUPANCY V2 PASS (13 assertion) ===');
