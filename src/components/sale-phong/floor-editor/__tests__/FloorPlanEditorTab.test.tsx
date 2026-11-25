// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FloorLayoutsMap, StoredFloorLayout } from '@/pages/phong-trong/floorLayoutShared';

type Filter = [kind: 'eq' | 'is', column: string, value: unknown];
interface ServerRow { id: string; deleted_at: null; floor_layouts: FloorLayoutsMap; updated_at: string }

/** Một dòng `buildings` trên "máy chủ" giả: SELECT/UPDATE qua chuỗi PostgREST, UPDATE đổi `updated_at` như trigger. */
const db = vi.hoisted(() => ({
  rows: {} as Record<string, ServerRow>,
  clock: 0,
  denyUpdates: false,
  calls: [] as Array<{ op: 'select' | 'update'; filters: Filter[]; payload?: { floor_layouts: FloorLayoutsMap } }>,
  buildings: [] as Array<{ id: string; name: string; code: string | null; floor_layouts: FloorLayoutsMap | null }>,
  rooms: {} as Record<string, Array<{ id: string; name: string; code: string; floor: number; area: number; status: string }>>,
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table !== 'buildings') throw new Error(`unexpected table ${table}`);
      const call: { op: 'select' | 'update'; filters: Filter[]; payload?: { floor_layouts: FloorLayoutsMap } } = { op: 'select', filters: [] };
      const matches = (row: ServerRow | undefined) => !!row && call.filters.every(([, column, value]) => (row as unknown as Record<string, unknown>)[column] === value);
      const builder = {
        select: () => builder,
        update: (payload: { floor_layouts: FloorLayoutsMap }) => { call.op = 'update'; call.payload = structuredClone(payload); return builder; },
        eq: (column: string, value: unknown) => { call.filters.push(['eq', column, value]); return builder; },
        is: (column: string, value: unknown) => { call.filters.push(['is', column, value]); return builder; },
        maybeSingle: async () => {
          db.calls.push(structuredClone(call));
          const id = call.filters.find(([, column]) => column === 'id')?.[2] as string;
          const row = db.rows[id];
          if (!matches(row) || (call.op === 'update' && db.denyUpdates)) return { data: null, error: null };
          if (call.op === 'update' && call.payload) {
            db.clock += 1;
            row.floor_layouts = structuredClone(call.payload.floor_layouts);
            row.updated_at = `2026-11-25T03:00:0${db.clock}.123456+00:00`;
          }
          return { data: { id: row.id, floor_layouts: structuredClone(row.floor_layouts), updated_at: row.updated_at }, error: null };
        },
      };
      return builder;
    },
  },
}));
vi.mock('sonner', () => ({ toast: db.toast }));
vi.mock('@/hooks/useBuildings', () => ({ useBuildings: () => ({ data: db.buildings }) }));
vi.mock('@/hooks/useRooms', () => ({ useRooms: (id?: string) => ({ data: id ? db.rooms[id] : undefined }) }));
vi.mock('@/components/ui/searchable-select', () => ({
  SearchableSelect: ({ value, onValueChange, options, placeholder, disabled }: {
    value?: string; onValueChange: (value: string) => void; options: Array<{ value: string; label: ReactNode }>;
    placeholder?: ReactNode; disabled?: boolean;
  }) => <select aria-label={String(placeholder)} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>
    <option value="">—</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
// Canvas thật cần ResizeObserver + kéo chuột; thay bằng nút "kéo phòng sang phải 10".
vi.mock('../EditorCanvas', () => ({
  default: ({ draft, onChange, onChangeEnd }: {
    draft: StoredFloorLayout; onChange: (kind: string, id: string, box: StoredFloorLayout['rooms'][string]) => void; onChangeEnd: () => void;
  }) => <div aria-label="Sơ đồ đang sửa">{Object.entries(draft.rooms).map(([id, box]) => <button key={id} type="button"
    onClick={() => { onChange('room', id, { ...box, x: box.x + 10 }); onChangeEnd(); }}>Kéo {id} (x={box.x})</button>)}</div>,
}));

import FloorPlanEditorTab from '../FloorPlanEditorTab';

const layout = (x: number): StoredFloorLayout => ({
  canvasW: 600, canvasH: 400, corridor: { x: 0, y: 180, w: 600, h: 40 }, fixtures: [], rooms: { 'r-201': { x, y: 10, w: 150, h: 118 } },
});
const T0 = '2026-11-25T02:59:00.000001+00:00';
const otherUserSaves = (id: string, floorLayouts: FloorLayoutsMap) => {
  db.clock += 1; db.rows[id].floor_layouts = structuredClone(floorLayouts); db.rows[id].updated_at = `2026-11-25T03:00:0${db.clock}.654321+00:00`;
};
const updates = () => db.calls.filter(call => call.op === 'update');

let client: QueryClient;
const renderTab = (props: { onDirtyChange?: (dirty: boolean) => void } = {}) =>
  render(<QueryClientProvider client={client}><FloorPlanEditorTab {...props} /></QueryClientProvider>);
const pickBuilding = (id: string) => fireEvent.change(screen.getByLabelText('Chọn toà nhà'), { target: { value: id } });
const pickFloor = (floor: string) => fireEvent.change(screen.getByLabelText('Chọn tầng'), { target: { value: floor } });
const saveButton = () => screen.getByRole('button', { name: /Lưu sơ đồ|Đang lưu/ });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  db.clock = 0; db.calls = []; db.denyUpdates = false;
  db.toast.success.mockReset(); db.toast.error.mockReset();
  // Mở toà lúc máy chủ có tầng 2; tầng 1 chưa có sơ đồ (editor tự xếp tạm).
  db.buildings = [
    { id: 'b-102', name: '102LVT', code: null, floor_layouts: { 2: layout(10) } },
    { id: 'b-45', name: '45TTT', code: null, floor_layouts: null },
  ];
  db.rows = {
    'b-102': { id: 'b-102', deleted_at: null, floor_layouts: { 2: layout(10) }, updated_at: T0 },
    'b-45': { id: 'b-45', deleted_at: null, floor_layouts: {}, updated_at: T0 },
  };
  db.rooms = {
    'b-102': [
      { id: 'r-201', name: '201', code: '201', floor: 2, area: 20, status: 'AVAILABLE' },
      { id: 'r-101', name: '101', code: '101', floor: 1, area: 20, status: 'OCCUPIED' },
    ],
    'b-45': [{ id: 'r-45', name: 'P1', code: 'P1', floor: 1, area: 18, status: 'AVAILABLE' }],
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('lưu chỉ gửi tầng đã sửa, gộp lên bản mới nhất và ghi có điều kiện updated_at; tầng chỉ mở xem không bị ghi', async () => {
  renderTab(); pickBuilding('b-102');
  pickFloor('1'); // xem tầng tự xếp tạm, không sửa
  expect(screen.queryByText(/Chưa lưu/)).toBeNull();
  pickFloor('2');
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=10)' }));
  expect(screen.getByText('Chưa lưu: tầng 2')).toBeTruthy();
  otherUserSaves('b-102', { 2: layout(10), 7: layout(70) }); // người khác lưu tầng 7 trong lúc mình sửa
  const before = db.rows['b-102'].updated_at;
  fireEvent.click(saveButton());
  await waitFor(() => expect(db.toast.success).toHaveBeenCalledWith('Đã lưu sơ đồ tầng 2.'));
  expect(updates()).toHaveLength(1);
  expect(updates()[0].payload).toEqual({ floor_layouts: { 2: layout(20), 7: layout(70) } });
  expect(updates()[0].filters).toEqual([['eq', 'id', 'b-102'], ['eq', 'updated_at', before]]);
  expect(db.rows['b-102'].floor_layouts[1]).toBeUndefined();
  expect(screen.queryByText(/Chưa lưu/)).toBeNull();
  expect(saveButton()).toHaveProperty('disabled', true);
});

it('người khác đã lưu đúng tầng mình sửa: báo «đã có người sửa», không ghi; tải bản mới nhất thay bản đang sửa', async () => {
  renderTab(); pickBuilding('b-102');
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=10)' }));
  otherUserSaves('b-102', { 2: layout(30) });
  fireEvent.click(saveButton());
  expect((await screen.findByRole('alert')).textContent).toContain('Đã có người sửa sơ đồ tầng 2');
  expect(updates()).toEqual([]);
  expect(db.rows['b-102'].floor_layouts).toEqual({ 2: layout(30) });
  expect(screen.getByText('Chưa lưu: tầng 2')).toBeTruthy(); // bản đang sửa vẫn giữ
  fireEvent.click(screen.getByRole('button', { name: 'Tải bản mới nhất' }));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('tầng 2'));
  expect(await screen.findByRole('button', { name: 'Kéo r-201 (x=30)' })).toBeTruthy();
  expect(screen.queryByText(/Chưa lưu/)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('đổi toà khi còn tầng chưa lưu thì hỏi; huỷ thì giữ nguyên toà và bản đang sửa', () => {
  renderTab(); pickBuilding('b-102');
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=10)' }));
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  pickBuilding('b-45');
  expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/chưa lưu ở tầng 2.*chuyển sang toà khác/));
  expect(screen.getByLabelText('Chọn toà nhà')).toHaveProperty('value', 'b-102');
  expect(screen.getByRole('button', { name: 'Kéo r-201 (x=20)' })).toBeTruthy();
  pickBuilding('b-45');
  expect(screen.getByLabelText('Chọn toà nhà')).toHaveProperty('value', 'b-45');
  expect(screen.queryByText(/Chưa lưu/)).toBeNull();
  // Đổi toà khi không có gì chưa lưu: không hỏi.
  vi.mocked(window.confirm).mockClear();
  pickBuilding('b-102');
  expect(window.confirm).not.toHaveBeenCalled();
});

it('hoàn tác về đúng bản cũ thì không còn tính là chưa lưu, không hỏi khi đổi toà', () => {
  renderTab(); pickBuilding('b-102');
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=10)' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
  expect(screen.queryByText(/Chưa lưu/)).toBeNull();
  pickBuilding('b-45');
  expect(window.confirm).not.toHaveBeenCalled();
});

it('báo trang cha khi có/không còn tầng chưa lưu và chặn đóng trang khi đang dở', async () => {
  const onDirtyChange = vi.fn();
  const view = renderTab({ onDirtyChange }); pickBuilding('b-102');
  const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
  expect(unload()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=10)' }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(unload()).toBe(true);
  fireEvent.click(saveButton());
  await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  expect(unload()).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=20)' }));
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
});

it('tài khoản không được sửa toà: báo thiếu quyền, không báo nhầm là có người sửa', async () => {
  renderTab(); pickBuilding('b-102');
  fireEvent.click(screen.getByRole('button', { name: 'Kéo r-201 (x=10)' }));
  // RLS lọc mất dòng khi UPDATE: PostgREST trả 0 dòng, updated_at không đổi.
  db.denyUpdates = true;
  fireEvent.click(saveButton());
  expect((await screen.findByRole('alert')).textContent).toMatch(/chưa được sửa toà nhà này/);
  expect(screen.queryByRole('button', { name: 'Tải bản mới nhất' })).toBeNull();
  expect(screen.getByText('Chưa lưu: tầng 2')).toBeTruthy();
});

it('danh sách toà xếp theo tên tự nhiên', () => {
  renderTab();
  expect([...(screen.getByLabelText('Chọn toà nhà') as HTMLSelectElement).options].map(option => option.textContent))
    .toEqual(['—', '45TTT', '102LVT']);
});
