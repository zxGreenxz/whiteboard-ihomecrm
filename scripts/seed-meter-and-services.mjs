/**
 * Seed: tạo công tơ điện cho mọi phòng + 1 reading APPROVED dùng "Chỉ số đầu" trong sheet "04"
 * của file Excel ở dataexcel/, đồng thời tạo 3 service chuẩn (Tiền điện, Tiền nước, Phí dịch vụ)
 * và gán vào tất cả tòa nhà qua service_buildings + building_services (PDV=150k, Nước=100k/người, Điện=3500/kWh).
 *
 * Idempotent: chạy lại không trùng lặp dữ liệu.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-meter-and-services.mjs
 *
 * Hoặc đặt biến trong .env.local rồi: node --env-file=.env.local scripts/seed-meter-and-services.mjs
 */
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx/xlsx.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';

XLSX.set_fs(fs);

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://tryymsxyyckgbrmmvozx.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error('Thiếu SUPABASE_SERVICE_ROLE_KEY env var.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const DATA_DIR = path.resolve('dataexcel');

// === Tham số mặc định ===
const ELEC_PRICE = 3500;
const WATER_PRICE = 100000; // /Người
const PDV_PRICE = 150000;   // /Phòng
const SETTLEMENT_MONTH = '2026-04'; // chỉ số cuối Excel sheet "04" — dùng làm chỉ số đầu cho kỳ tháng 5
const READING_DATE = '2026-04-30';

// Build-name normalize: bỏ "/" "-" "  " và lower-case để so sánh tên file vs tên DB.
function norm(name) {
  return String(name)
    .toLowerCase()
    .replace(/[\s\/_-]+/g, '')
    .normalize('NFC');
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (rows[i].some((c) => typeof c === 'string' && c.includes('Chỉ số đầu'))) return i;
  }
  return -1;
}

function colIdx(header, label) {
  return header.findIndex(
    (c) => typeof c === 'string' && c.trim().toLowerCase() === label.trim().toLowerCase()
  );
}

function parseBuildingExcel(absPath) {
  const buf = fs.readFileSync(absPath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets['04'];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const hdr = findHeaderRow(rows);
  if (hdr < 0) return [];
  const header = rows[hdr];
  const cPhong = colIdx(header, 'Phòng');
  const cDau = colIdx(header, 'Chỉ số đầu');
  const cCuoi = colIdx(header, 'Chỉ số cuối');
  if (cPhong < 0 || cDau < 0) return [];

  const out = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    const ph = r[cPhong];
    if (ph == null || ph === '' || String(ph).toUpperCase() === 'TỔNG') continue;
    const phStr = String(ph).trim();
    const dau = Number(r[cDau]);
    const cuoi = r[cCuoi] != null ? Number(r[cCuoi]) : null;
    if (!Number.isFinite(dau)) continue;
    out.push({ room: phStr, chiSoDau: dau, chiSoCuoi: Number.isFinite(cuoi) ? cuoi : null });
  }
  // Một file có thể trùng "phòng" cho dòng "khách cũ" — gộp lấy lần đầu (chỉ số đầu là chuẩn từ tháng trước)
  const dedup = new Map();
  for (const r of out) if (!dedup.has(r.room)) dedup.set(r.room, r);
  return Array.from(dedup.values());
}

async function ensureCanonicalService({ name, code, fee_type, type, unit, unit_price, user_id }) {
  // Tìm theo (user_id, name, fee_type) — đảm bảo không trùng do gặp lại
  const { data: existing } = await sb
    .from('services')
    .select('id, name, unit_price')
    .eq('user_id', user_id)
    .eq('name', name)
    .eq('fee_type', fee_type)
    .is('deleted_at', null)
    .limit(1);
  if (existing && existing.length > 0) {
    console.log(`  • service exists: ${name} (${fee_type}) id=${existing[0].id}`);
    return existing[0].id;
  }
  const { data, error } = await sb
    .from('services')
    .insert({ name, code, fee_type, type, unit, unit_price, user_id })
    .select('id')
    .single();
  if (error) throw error;
  console.log(`  + service created: ${name} (${fee_type}) id=${data.id}`);
  return data.id;
}

async function ensureServiceBuildingLink(service_id, building_id) {
  const { data: row } = await sb
    .from('service_buildings')
    .select('service_id')
    .eq('service_id', service_id)
    .eq('building_id', building_id)
    .limit(1);
  if (row && row.length > 0) return;
  const { error } = await sb.from('service_buildings').insert({ service_id, building_id });
  if (error) throw error;
}

async function ensureBuildingService({ building_id, service_id, unit_price_override }) {
  const { data: row } = await sb
    .from('building_services')
    .select('id, unit_price_override, is_active')
    .eq('building_id', building_id)
    .eq('service_id', service_id)
    .limit(1);
  if (row && row.length > 0) {
    // Cập nhật giá nếu khác
    if (row[0].unit_price_override !== unit_price_override) {
      await sb
        .from('building_services')
        .update({ unit_price_override, is_active: true })
        .eq('id', row[0].id);
    }
    return row[0].id;
  }
  const { data, error } = await sb
    .from('building_services')
    .insert({ building_id, service_id, unit_price_override, is_active: true })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function ensureMeter({ user_id, code, building_id, room_id, service_id, initial_reading }) {
  const { data: row } = await sb
    .from('meters')
    .select('id, initial_reading')
    .eq('user_id', user_id)
    .eq('code', code)
    .is('deleted_at', null)
    .limit(1);
  if (row && row.length > 0) return row[0].id;
  const { data, error } = await sb
    .from('meters')
    .insert({
      user_id,
      code,
      building_id,
      room_id,
      service_id,
      meter_type: 'ELECTRICITY',
      name: `Công tơ điện ${code}`,
      initial_reading,
      status: 'ACTIVE',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function ensureSeedReading({ user_id, meter_id, reading_date, settlement_month, current_reading, service_id }) {
  // Đã có reading nào cho meter này tại settlement_month chưa?
  const { data: row } = await sb
    .from('meter_readings')
    .select('id')
    .eq('meter_id', meter_id)
    .eq('settlement_month', settlement_month)
    .is('deleted_at', null)
    .limit(1);
  if (row && row.length > 0) return row[0].id;
  const { data, error } = await sb
    .from('meter_readings')
    .insert({
      user_id,
      meter_id,
      reading_date,
      settlement_month,
      previous_reading: 0,
      current_reading,
      status: 'APPROVED',
      approved_by: user_id,
      approved_at: new Date().toISOString(),
      recorded_by: user_id,
      meter_type: 'ELECTRICITY',
      service_id,
      notes: 'Seed từ file Excel tháng 4 (chỉ số đầu = chỉ số cuối tháng 3)',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

(async function main() {
  // 0) Cleanup: xoá reading seed sai trước đó (settlement_month='2026-03') để re-seed bằng chỉ số cuối tháng 4.
  if (process.env.RESEED === '1') {
    const { error: delErr, count } = await sb
      .from('meter_readings')
      .delete({ count: 'exact' })
      .eq('settlement_month', '2026-03')
      .eq('status', 'APPROVED')
      .like('notes', 'Seed từ file Excel%');
    if (delErr) console.warn('Cleanup warning:', delErr);
    else console.log(`Cleanup: xoá ${count ?? 0} reading seed cũ (2026-03).`);
  }

  // 1) Buildings + chọn user_id chung
  const { data: buildings, error: e1 } = await sb
    .from('buildings')
    .select('id, name, user_id')
    .is('deleted_at', null);
  if (e1) throw e1;
  if (!buildings || buildings.length === 0) {
    console.error('Không có building nào.');
    process.exit(1);
  }
  const userId = buildings[0].user_id;
  console.log(`Found ${buildings.length} buildings, using user_id=${userId}`);

  // 2) Tạo 3 service chuẩn
  console.log('\n=== Tạo / lấy 3 service chuẩn ===');
  const elecId = await ensureCanonicalService({
    name: 'Tiền điện',
    code: 'TIEN_DIEN_DEFAULT',
    fee_type: 'TIEN_DIEN',
    type: 'METER_READING',
    unit: 'Kwh',
    unit_price: ELEC_PRICE,
    user_id: userId,
  });
  const waterId = await ensureCanonicalService({
    name: 'Tiền nước',
    code: 'TIEN_NUOC_DEFAULT',
    fee_type: 'TIEN_NUOC',
    type: 'PER_PERSON',
    unit: 'Người',
    unit_price: WATER_PRICE,
    user_id: userId,
  });
  const pdvId = await ensureCanonicalService({
    name: 'Phí dịch vụ',
    code: 'PDV_DEFAULT',
    fee_type: 'TIEN_PHI_DICH_VU',
    type: 'PER_ROOM',
    unit: 'Phòng',
    unit_price: PDV_PRICE,
    user_id: userId,
  });

  // 3) Files Excel theo tòa
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => /\.xlsx$/i.test(f) && !/^danh_sach/.test(f));
  const fileByBuilding = new Map(); // norm(name) -> filename
  for (const f of files) fileByBuilding.set(norm(path.basename(f, path.extname(f))), f);

  // 4) Loop từng building
  let okBuilding = 0;
  let okMeter = 0;
  let okReading = 0;
  for (const b of buildings) {
    console.log(`\n=== Toà ${b.name} ===`);
    // Gán 3 service vào tòa
    await Promise.all([
      ensureServiceBuildingLink(elecId, b.id),
      ensureServiceBuildingLink(waterId, b.id),
      ensureServiceBuildingLink(pdvId, b.id),
    ]);
    await Promise.all([
      ensureBuildingService({ building_id: b.id, service_id: elecId, unit_price_override: ELEC_PRICE }),
      ensureBuildingService({ building_id: b.id, service_id: waterId, unit_price_override: WATER_PRICE }),
      ensureBuildingService({ building_id: b.id, service_id: pdvId, unit_price_override: PDV_PRICE }),
    ]);
    okBuilding++;

    // Tìm file Excel cho tòa
    const file = fileByBuilding.get(norm(b.name));
    if (!file) {
      console.log(`  · Không có file Excel ứng với tòa "${b.name}", bỏ qua công tơ.`);
      continue;
    }
    const records = parseBuildingExcel(path.join(DATA_DIR, file));
    if (records.length === 0) {
      console.log(`  · File ${file} không có sheet "04" hoặc không đọc được dòng dữ liệu.`);
      continue;
    }

    // Lấy danh sách phòng của tòa từ DB
    const { data: rooms } = await sb
      .from('rooms')
      .select('id, name')
      .eq('building_id', b.id)
      .is('deleted_at', null);
    const roomByName = new Map();
    rooms?.forEach((r) => roomByName.set(String(r.name).trim(), r.id));

    for (const rec of records) {
      // Tên phòng excel có thể là "01" hoặc 1 — match cả hai
      const candidates = new Set([
        rec.room,
        rec.room.padStart(2, '0'),
        rec.room.replace(/^0+/, ''),
      ]);
      let roomId = null;
      for (const c of candidates) {
        if (roomByName.has(c)) { roomId = roomByName.get(c); break; }
      }
      if (!roomId) {
        console.log(`  ! không khớp phòng "${rec.room}" trong DB`);
        continue;
      }
      const code = `CTD-${b.name.replace(/\s+/g, '')}-${String(rec.room).padStart(2, '0')}`;
      const meterId = await ensureMeter({
        user_id: userId,
        code,
        building_id: b.id,
        room_id: roomId,
        service_id: elecId,
        initial_reading: rec.chiSoDau,
      });
      okMeter++;
      // Bỏ qua phòng chưa có chỉ số cuối tháng 4
      if (rec.chiSoCuoi == null || rec.chiSoCuoi < rec.chiSoDau) continue;
      const readingId = await ensureSeedReading({
        user_id: userId,
        meter_id: meterId,
        reading_date: READING_DATE,
        settlement_month: SETTLEMENT_MONTH,
        current_reading: rec.chiSoCuoi,
        service_id: elecId,
      });
      if (readingId) okReading++;
    }
  }

  console.log(`\n✅ Done — buildings=${okBuilding}, meters=${okMeter}, readings=${okReading}`);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
