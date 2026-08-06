import { describe, expect, it } from 'vitest';
import { collectRoutes, GUARDS, PUBLIC_ROUTES } from '../check-route-guards.mjs';

// Gate này canh một thứ không test nào khác canh: route mới thêm mà quên bọc
// guard. Bản thân nó sai thì nó sẽ báo XANH cho một trang đang hở — nên nó cần
// test hơn hầu hết code khác.

const bocRoutes = (jsx) => collectRoutes(`
  export default function App() {
    return (<Routes>${jsx}</Routes>);
  }
`);

describe('collectRoutes — guard nằm trong element', () => {
  it('nhận guard là CON của Route (dạng phổ biến nhất trong repo)', () => {
    const r = bocRoutes(`<Route path="/x" element={<ProtectedRoute><RequirePermission module="m"><Page /></RequirePermission></ProtectedRoute>} />`);
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe('/x');
    expect(r[0].guards).toEqual(['ProtectedRoute', 'RequirePermission']);
  });

  it('nhận guard là TỔ TIÊN (layout route bọc nhóm con)', () => {
    const r = bocRoutes(`<Route element={<ProtectedRoute><Layout /></ProtectedRoute>}><Route path="/con" element={<Page />} /></Route>`);
    const con = r.find((x) => x.path === '/con');
    expect(con.guards).toContain('ProtectedRoute');
  });

  it('KHÔNG nhầm JSX lồng bên trong là kết thúc Route — đây là lỗi của bản quét ký tự', () => {
    const r = bocRoutes(`
      <Route path="/a" element={<ProtectedRoute><Page /></ProtectedRoute>} />
      <Route path="/b" element={<ProtectedRoute><Other /></ProtectedRoute>} />
    `);
    expect(r.map((x) => x.path)).toEqual(['/a', '/b']);
  });
});

describe('collectRoutes — route không có guard', () => {
  it('báo guards rỗng khi thiếu guard thật', () => {
    const r = bocRoutes(`<Route path="/ho" element={<Page />} />`);
    expect(r[0].guards).toEqual([]);
    expect(r[0].redirect).toBe(false);
  });

  it('component tự chế KHÔNG được tính là guard', () => {
    const r = bocRoutes(`<Route path="/gia" element={<TuCheGuard><Page /></TuCheGuard>} />`);
    expect(r[0].guards).toEqual([]);
  });
});

describe('collectRoutes — redirect', () => {
  it('nhận <Navigate> trực tiếp là redirect', () => {
    const r = bocRoutes(`<Route path="/cu" element={<Navigate to="/moi" replace />} />`);
    expect(r[0].redirect).toBe(true);
  });

  it('nhận component cục bộ chỉ trả <Navigate> là redirect', () => {
    // Đúng ca TenantToCustomerRedirect: bọc trong component có tên nên kiểm tra
    // "element chỉ là Navigate" không thấy.
    const r = collectRoutes(`
      function ChuyenHuong() {
        const { id } = useParams();
        return <Navigate to={'/customers/' + id} replace />;
      }
      export default function App() {
        return (<Routes><Route path="/cu/:id" element={<ChuyenHuong />} /></Routes>);
      }
    `);
    const route = r.find((x) => x.path === '/cu/:id');
    expect(route.redirect).toBe(true);
  });

  it('component có render thêm thứ khác thì KHÔNG phải redirect', () => {
    const r = collectRoutes(`
      function NuaVoi() {
        return <div><Banner /><Navigate to="/x" /></div>;
      }
      export default function App() {
        return (<Routes><Route path="/y" element={<NuaVoi />} /></Routes>);
      }
    `);
    expect(r.find((x) => x.path === '/y').redirect).toBe(false);
  });
});

describe('danh sách khai báo', () => {
  it('ProtectedRoute và RequirePermission đều được tính là guard', () => {
    expect(GUARDS.has('ProtectedRoute')).toBe(true);
    expect(GUARDS.has('RequirePermission')).toBe(true);
  });

  it('mọi route công khai đều có lý do kèm theo — danh sách này là bề mặt tấn công', () => {
    for (const [path, lyDo] of PUBLIC_ROUTES) {
      expect(typeof lyDo, `${path} thiếu lý do`).toBe('string');
      expect(lyDo.length, `${path} có lý do rỗng`).toBeGreaterThan(3);
    }
  });
});
