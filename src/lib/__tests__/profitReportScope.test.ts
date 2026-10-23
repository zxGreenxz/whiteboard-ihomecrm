import { describe, expect, it } from 'vitest';
import { NO_BUILDING_ID, orgBuildingsOf, profitScopeIds } from '@/lib/profitReportScope';

const ORG = 'org-that';
const DEMO = 'org-demo';
const all = [
  { id: 'a', organization_id: ORG },
  { id: 'b', organization_id: ORG },
  { id: 'd', organization_id: DEMO },
];

describe('phạm vi toà của Báo cáo LN theo công ty đang chọn', () => {
  it('chỉ giữ toà của công ty đang chọn; chưa chốt công ty ⇒ rỗng (không đoán)', () => {
    expect(orgBuildingsOf(all, ORG).map((b) => b.id)).toEqual(['a', 'b']);
    expect(orgBuildingsOf(all, null)).toEqual([]);
  });
  it('không chọn toà ⇒ mọi toà của công ty, KHÔNG để trống (trống = mọi công ty qua RLS)', () => {
    expect(profitScopeIds(orgBuildingsOf(all, ORG), [])).toEqual(['a', 'b']);
  });
  it('toà đã chọn của công ty khác (còn lưu từ lần trước) bị bỏ', () => {
    expect(profitScopeIds(orgBuildingsOf(all, ORG), ['b', 'd'])).toEqual(['b']);
    expect(profitScopeIds(orgBuildingsOf(all, ORG), ['d'])).toEqual(['a', 'b']);
  });
  it('công ty chưa có toà / chưa nạp xong ⇒ mã giả, báo cáo rỗng chứ không rơi về mọi toà', () => {
    expect(profitScopeIds([], [])).toEqual([NO_BUILDING_ID]);
    expect(profitScopeIds(orgBuildingsOf(all, 'org-moi'), ['a'])).toEqual([NO_BUILDING_ID]);
  });
});
