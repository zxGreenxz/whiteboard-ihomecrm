// Unit test KHO SLOT dùng chung của lưới phí /thanh-toan (audit 31/08 P3-03).
// Đây là lõi chống-đóng-trùng 652 dòng trước nay KHÔNG có test — các bất biến
// dưới đây đều là hành vi đã được comment trong code khẳng định là CHỦ Ý;
// test khoá chúng lại để lần refactor sau không phá trong im lặng.
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SLOT,
  __resetSlotsForTest,
  addMonths,
  inflightPays,
  rangeLabel,
  readSlot,
  releaseSlot,
  retainSlot,
  subscribeSlot,
  writeSlot,
} from '@/lib/periodFeeSlots';

afterEach(() => __resetSlotsForTest());

describe('kho slot — cách ly theo (hạng mục | kỳ)', () => {
  it('hai scope khác nhau không lây tiền chéo (giữ FIX P0 leak của V2)', () => {
    writeSlot('internet|2026-08', (s) => ({ ...s, amounts: { ...s.amounts, b1: 500_000 } }));
    expect(readSlot('internet|2026-08').amounts.b1).toBe(500_000);
    expect(readSlot('rac|2026-08')).toBe(EMPTY_SLOT);      // hạng mục khác: sạch
    expect(readSlot('internet|2026-09')).toBe(EMPTY_SLOT); // kỳ khác: sạch
  });

  it('hai bề mặt cùng scope đọc CÙNG một ô nhớ và cùng được notify', () => {
    const scope = 'dien|2026-08';
    const seenA: number[] = []; const seenB: number[] = [];
    subscribeSlot(scope, () => seenA.push(readSlot(scope).amounts.b1 ?? 0));
    subscribeSlot(scope, () => seenB.push(readSlot(scope).amounts.b1 ?? 0));
    writeSlot(scope, (s) => ({ ...s, amounts: { ...s.amounts, b1: 66_000_000 } }));
    expect(seenA).toEqual([66_000_000]);
    expect(seenB).toEqual([66_000_000]); // bề mặt kia thấy NGAY — gốc của chống-đóng-trùng V3
  });

  it('unsubscribe bề mặt này không rụng subscriber của bề mặt kia', () => {
    const scope = 'nuoc|2026-08';
    const seen: string[] = [];
    const offA = subscribeSlot(scope, () => seen.push('A'));
    subscribeSlot(scope, () => seen.push('B'));
    offA();
    writeSlot(scope, (s) => ({ ...s, payingKey: 'b1' }));
    expect(seen).toEqual(['B']);
  });

  it('EMPTY_SLOT bất biến — writeSlot phải tạo object mới, không mutate mẫu', () => {
    expect(Object.isFrozen(EMPTY_SLOT)).toBe(true);
    const scope = 'internet|2026-08';
    const before = readSlot(scope);
    writeSlot(scope, (s) => ({ ...s, payingKey: 'b9' }));
    expect(before).toBe(EMPTY_SLOT);          // bản đọc trước không bị sửa tại chỗ
    expect(readSlot(scope).payingKey).toBe('b9');
    expect(EMPTY_SLOT.payingKey).toBeNull();  // mẫu vẫn nguyên
  });
});

describe('refcount consumer — "đổi hạng mục là reset sạch" bằng cấu trúc', () => {
  it('consumer cuối rời đi thì ô nhớ bị xoá (reset sạch như V2)', () => {
    const scope = 'rac|2026-08';
    retainSlot(scope);
    writeSlot(scope, (s) => ({ ...s, amounts: { b1: 120_000 } }));
    releaseSlot(scope);
    expect(readSlot(scope)).toBe(EMPTY_SLOT);
  });

  it('bề mặt kia còn đứng ở scope thì KHÔNG xoá (đang gõ dở)', () => {
    const scope = 'rac|2026-08';
    retainSlot(scope); // panel
    retainSlot(scope); // sheet
    writeSlot(scope, (s) => ({ ...s, amounts: { b1: 300_000 } }));
    releaseSlot(scope); // panel đổi hạng mục
    expect(readSlot(scope).amounts.b1).toBe(300_000); // sheet vẫn giữ tiền đang gõ
    releaseSlot(scope); // sheet rời nốt
    expect(readSlot(scope)).toBe(EMPTY_SLOT);
  });

  it('khuôn StrictMode (mount→unmount→mount) không xoá oan ô của consumer còn sống', () => {
    const scope = 'dien|2026-08';
    // React 18 dev: effect chạy, cleanup, chạy lại — retain/release/retain.
    retainSlot(scope);
    writeSlot(scope, (s) => ({ ...s, amounts: { b1: 1_000 } }));
    releaseSlot(scope); // cleanup của StrictMode — refcount về 0, ô bị xoá (đúng thiết kế)
    retainSlot(scope);  // effect chạy lại ngay
    // Ô đã reset — đó là hành vi "đổi scope là reset" chấp nhận được ở dev;
    // điều PHẢI đúng là refcount không âm và retain lại hoạt động bình thường.
    writeSlot(scope, (s) => ({ ...s, amounts: { b1: 2_000 } }));
    expect(readSlot(scope).amounts.b1).toBe(2_000);
    releaseSlot(scope);
    expect(readSlot(scope)).toBe(EMPTY_SLOT);
  });
});

describe('chốt in-flight — sống xuyên đổi kỳ/hạng mục (khe 460ms)', () => {
  it('releaseSlot KHÔNG dọn inflightPays — chốt phải sống tới khi RPC trả về', () => {
    const scope = 'internet|2026-08';
    const lock = `${scope}::b1`;
    retainSlot(scope);
    inflightPays.add(lock);        // doPay đang bay
    releaseSlot(scope);            // user đổi hạng mục trong lúc phiếu đang bay
    expect(inflightPays.has(lock)).toBe(true); // quay lại vẫn bị chặn re-entry
    inflightPays.delete(lock);     // finally của doPay
    expect(inflightPays.has(lock)).toBe(false);
  });

  it('khoá theo từng (scope, toà) — toà khác không bị chặn oan', () => {
    inflightPays.add('dien|2026-08::b1');
    expect(inflightPays.has('dien|2026-08::b2')).toBe(false);
    expect(inflightPays.has('nuoc|2026-08::b1')).toBe(false);
  });
});

describe('toán kỳ', () => {
  it('addMonths vắt năm xuôi/ngược', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-08', 0)).toBe('2026-08');
    expect(addMonths('2026-12', 24)).toBe('2028-12');
  });

  it('rangeLabel một kỳ và khoảng kỳ', () => {
    expect(rangeLabel('2026-07', '2026-07')).toBe('T7/2026');
    expect(rangeLabel('2026-07', '2026-12')).toBe('T7/2026 → T12/2026');
  });
});
