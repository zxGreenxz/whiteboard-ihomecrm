// Chọn tổ chức phải là một LỰA CHỌN, không phải thứ tự sắp xếp.
//
// Trước 14/08/2026 context đặt `organization = organizations[0]`. Với người chỉ
// thuộc một công ty thì đúng, nhưng với người thuộc nhiều công ty thì công ty
// "hiện tại" do `ORDER BY o.name` trong RPC quyết định — đổi tên công ty là đổi
// sổ đang xem, và không ai được báo gì cả.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  isOrgAgnosticQueryKey,
  parseOrganizations,
  resetOrgScopedQueries,
  resolveSelectedOrganizationId,
  type Organization,
} from '../OrganizationContext';

const org = (id: string, name = id): Organization => ({
  id,
  name,
  slug: null,
  memberType: 'MEMBER',
});

const orgA = org('aaaa0000-0000-4000-8000-000000000001', 'Công ty A');
const orgB = org('bbbb0000-0000-4000-8000-000000000002', 'Công ty B');

describe('resolveSelectedOrganizationId', () => {
  it('MỘT công ty ⇒ tự chọn, không bắt người dùng bấm', () => {
    expect(resolveSelectedOrganizationId([orgA], null)).toBe(orgA.id);
  });

  it('NHIỀU công ty mà chưa chọn ⇒ null (fail closed)', () => {
    // null nghĩa là "chưa chốt", và mọi tool org-scoped phải từ chối chạy. Đoán
    // bừa một công ty ở đây là đoán bừa xem đọc sổ của ai.
    expect(resolveSelectedOrganizationId([orgA, orgB], null)).toBeNull();
  });

  it('NHIỀU công ty + lựa chọn hợp lệ ⇒ giữ đúng lựa chọn đó', () => {
    expect(resolveSelectedOrganizationId([orgA, orgB], orgB.id)).toBe(orgB.id);
  });

  it('còn ĐÚNG MỘT công ty thì auto-chọn thắng cả lựa chọn cũ đã hết hiệu lực', () => {
    // Người bị gỡ khỏi công ty B, lựa chọn lưu trong máy vẫn trỏ vào B, danh bạ
    // giờ chỉ còn A. Ở đây auto-chọn A là ĐÚNG, không phải "rơi âm thầm": A là
    // công ty duy nhất họ có, nên không tồn tại lựa chọn nào khác đúng hơn để mà
    // chọn nhầm. Chỗ nguy hiểm là nhiều công ty — ca đó rơi vào luật (3) bên dưới.
    //
    // Điều kiện đi kèm: giao diện PHẢI hiện tên công ty đang xem (yêu cầu số 1
    // trong chú thích đầu OrganizationContext). Auto-chọn mà không hiện tên thì
    // mới là im lặng.
    expect(resolveSelectedOrganizationId([orgA], orgB.id)).toBe(orgA.id);
  });

  it('NHIỀU công ty mà lựa chọn cũ đã hết hiệu lực ⇒ null, KHÔNG rơi về công ty đầu', () => {
    // Đây mới là ca nguy hiểm: có nhiều thứ để chọn nhầm. Hành vi cũ
    // (`organizations[0]`) sẽ đưa người dùng sang sổ công ty A mà không báo gì.
    const orgC = org('cccc0000-0000-4000-8000-000000000003', 'Công ty C');
    expect(resolveSelectedOrganizationId([orgA, orgC], orgB.id)).toBeNull();
  });

  it('danh bạ RỖNG ⇒ null dù có lựa chọn cũ', () => {
    expect(resolveSelectedOrganizationId([], orgA.id)).toBeNull();
    expect(resolveSelectedOrganizationId([], null)).toBeNull();
  });

  it('KHÔNG rơi về phần tử đầu khi lựa chọn hỏng (đây là hành vi cũ, phải mất)', () => {
    const ra = resolveSelectedOrganizationId([orgA, orgB], 'khong-ton-tai');
    expect(ra).toBeNull();
    expect(ra).not.toBe(orgA.id);
  });
});

describe('parseOrganizations', () => {
  it('bỏ dòng thiếu id/name thay vì render undefined', () => {
    const ra = parseOrganizations({
      organizations: [
        { id: 'x', name: 'Có tên', slug: 'x', member_type: 'OWNER' },
        { id: 'y' },
        { name: 'thiếu id' },
        null,
      ],
    });
    expect(ra).toHaveLength(1);
    expect(ra[0]).toEqual({ id: 'x', name: 'Có tên', slug: 'x', memberType: 'OWNER' });
  });

  it('payload hỏng ⇒ mảng rỗng, không ném', () => {
    for (const xau of [null, undefined, {}, { organizations: 'không phải mảng' }]) {
      expect(parseOrganizations(xau)).toEqual([]);
    }
  });
});

describe('OrganizationProvider RPC contract', () => {
  it('uses the Copilot organization directory RPC instead of the membership-only legacy RPC', () => {
    const source = readFileSync('src/contexts/OrganizationContext.tsx', 'utf8');
    expect(source).toContain("supabase.rpc('list_my_copilot_organizations_v1')");
    expect(source).not.toContain("supabase.rpc('get_my_organizations')");
  });
});

// ĐỔI CÔNG TY PHẢI DỌN CACHE.
//
// `selectOrganization` chỉ đổi một ID trong localStorage + state; nó không đụng
// tới queryClient. Nhưng phần lớn query trong app KHÔNG có organization_id
// trong queryKey (đo 15/09/2026: 741 trên 761 key), nên sau khi chuyển sang
// công ty B, màn hình vẫn dựng từ dữ liệu công ty A đã cache cho tới khi từng
// key hết hạn — sổ sách, hoá đơn, hợp đồng của công ty khác hiện dưới tên công
// ty đang chọn. RLS không cứu được: dữ liệu đã nằm sẵn trong bộ nhớ trình duyệt.
//
// Cùng khuôn với `syncAuthQueryCache` khi đổi người đăng nhập
// (src/lib/authQueryCache.ts): query đang có người xem thì `reset()` để nó nạp
// lại, query không ai xem thì bỏ hẳn khỏi cache.
describe('resetOrgScopedQueries', () => {
  const nap = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const cache = client.getQueryCache();
    for (const key of [
      ['auth', 'user'],
      ['auth', 'session'],
      ['my-organizations', 'u-1'],
      ['invoices', { page: 1 }],
      ['contracts-legacy', undefined],
      ['rooms'],
      ['accounts'],
    ]) {
      cache.build(client, { queryKey: key }).setData({ danhDau: key.join('|') });
    }
    return { client, cache };
  };

  it('bỏ MỌI key nghiệp vụ khỏi cache', () => {
    const { client, cache } = nap();
    resetOrgScopedQueries(client);
    const conLai = cache.getAll().map((q) => q.queryKey[0]).sort();
    expect(conLai).toEqual(['auth', 'auth', 'my-organizations']);
  });

  it('GIỮ phiên đăng nhập và danh bạ tổ chức — dọn hai thứ đó là tự đăng xuất', () => {
    const { client, cache } = nap();
    resetOrgScopedQueries(client);
    expect(cache.find({ queryKey: ['auth', 'user'] })?.state.data).toEqual({ danhDau: 'auth|user' });
    expect(cache.find({ queryKey: ['my-organizations', 'u-1'] })?.state.data)
      .toEqual({ danhDau: 'my-organizations|u-1' });
  });

  it('bất biến: key nào không phải auth/my-organizations thì không được sống sót', () => {
    const { client, cache } = nap();
    resetOrgScopedQueries(client);
    for (const q of cache.getAll()) {
      expect(isOrgAgnosticQueryKey(q.queryKey)).toBe(true);
    }
  });

  it('query đang có người xem thì chỉ RESET (giữ observer) chứ không xoá', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const cache = client.getQueryCache();
    const query = cache.build(client, { queryKey: ['invoices'] });
    query.setData({ so: 1 });
    const observer = new QueryObserver(client, { queryKey: ['invoices'], enabled: false });
    const unsubscribe = observer.subscribe(() => {});

    resetOrgScopedQueries(client);

    expect(cache.find({ queryKey: ['invoices'] })).toBeDefined();
    expect(cache.find({ queryKey: ['invoices'] })?.state.data).toBeUndefined();
    unsubscribe();
  });

  it('selectOrganization gọi hàm dọn này', () => {
    const source = readFileSync('src/contexts/OrganizationContext.tsx', 'utf8');
    expect(source).toContain('resetOrgScopedQueries(queryClient)');
  });
});
