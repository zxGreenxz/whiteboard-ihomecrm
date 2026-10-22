// One-off audit proof. This intentionally reproduces the current mismatch;
// a passing proof does NOT mean the product's cross-channel policy is correct.
import { afterAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// Mock only I/O dependencies. Both renderers below are the production exports.
vi.mock('../../../../worker/lib/ctx.js', () => ({
  sb: null, log: () => {}, orgOf: () => null, sessions: new Map(),
  SUPABASE_URL: 'https://synthetic.invalid',
}));
vi.mock('../../../../worker/lib/room-list-image.js', () => ({
  veAnhDanhSach: () => Promise.resolve(Buffer.from('')),
}));

const { soanTinPhong } = await import('../../../../worker/lib/automation.js');
const { buildRoomListTable } = await import('../../../../worker/lib/room-list-table.js');
const { MAC_DINH_BROADCAST } = await import('../../../../worker/lib/automation-config.js');
const evidence = [];
const passPolicy = 'Dữ liệu giả: miễn phí gửi một xe trong tháng đầu';
const room = {
  id: 'synthetic-room', code: 'P101', no: 101, floor: 1,
  status: 'pass', price: 3.5, area: 20, type: 'Studio',
  amenities: [], description: null, availDate: null, saleNote: '',
  passSalePolicy: passPolicy, buildingName: 'Tòa giả lập',
  buildingAddr: '1 Đường giả lập',
};
const building = {
  id: 'synthetic-building', name: 'Tòa giả lập',
  address: '1 Đường giả lập', phone: '', rooms: [room],
};

it('reproduces missing pass policy in room-detail text while the image table contains it', () => {
  const tablePolicy = buildRoomListTable([building]).groups[0].rows[0].policy;
  const template = 'Khuyến mãi: {khuyen_mai}';
  const detailText = soanTinPhong(room, template, '');
  const defaultDetailText = soanTinPhong(room, MAC_DINH_BROADCAST.template.roomTemplate, '');
  expect(tablePolicy).toBe(passPolicy);
  expect(detailText).toBe('Khuyến mãi:');
  expect(detailText).not.toContain(passPolicy);
  expect(defaultDetailText).not.toContain(passPolicy);
  evidence.push({
    case: 'pass-policy-fallback-mismatch',
    input: room,
    template,
    tablePolicy,
    detailText,
    defaultDetailText,
    findingReproduced: tablePolicy === passPolicy && !detailText.includes(passPolicy),
  });
});

it('control: an explicit room saleNote appears in both production renderers', () => {
  const explicit = 'Dữ liệu giả: giảm giá tháng đầu theo ghi chú phòng';
  const controlRoom = { ...room, saleNote: explicit };
  const tablePolicy = buildRoomListTable([{ ...building, rooms: [controlRoom] }]).groups[0].rows[0].policy;
  const detailText = soanTinPhong(controlRoom, 'Khuyến mãi: {khuyen_mai}', '');
  expect(tablePolicy).toBe(explicit);
  expect(detailText).toBe(`Khuyến mãi: ${explicit}`);
  evidence.push({ case: 'explicit-sale-note-control', tablePolicy, detailText });
});

afterAll(() => {
  const productionSources = [
    'worker/lib/automation.js',
    'worker/lib/room-list-table.js',
    'worker/lib/automation-config.js',
  ];
  const result = {
    kind: 'audit-reproduction-not-product-pass',
    recordedAt: new Date().toISOString(),
    syntheticOnly: true,
    networkOrDatabaseCalls: false,
    sources: productionSources.map(path => ({
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })),
    observations: evidence,
  };
  writeFileSync(new URL('./pass-policy-observations.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
});
