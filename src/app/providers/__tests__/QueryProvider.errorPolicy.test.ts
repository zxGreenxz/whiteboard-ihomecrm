// Sau khi 42 hook đọc đổi từ "nuốt lỗi" sang `throw`, lỗi có chỗ để đi — nhưng
// chưa có ai ĐÓN. Không có QueryCache.onError thì một query đọc hỏng chỉ để lại
// `isError` mà không màn nào đọc, tức vẫn im lặng, chỉ khác chỗ im.
//
// Hai rủi ro ngược nhau phải cùng chặn:
//   · im lặng — lỗi biến mất, đúng thứ đợt này đang sửa;
//   · ồn — hub realtime invalidate hàng chục key một lúc, một lần mất mạng nổ
//     40 toast chồng nhau và người dùng học cách bấm tắt mà không đọc.
// Nên: toast có chống lặp theo queryKey, và query nào tự khai `meta.silent` thì
// im hẳn (prefetch, thăm dò tuỳ chọn).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.fn();
const reportBoundaryError = vi.fn();

vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));
vi.mock("@/components/errors/boundaryReporter", () => ({
  reportBoundaryError: (...a: unknown[]) => reportBoundaryError(...a),
}));

const { KHOANG_LAP_TOAST_MS, nenBaoLoi, thongDiepLoiDoc, xuLyLoiQuery } = await import("../QueryProvider");

const truyVan = (key: unknown[], meta?: Record<string, unknown>) => ({ queryKey: key, meta });

beforeEach(() => {
  toastError.mockReset();
  reportBoundaryError.mockClear();
});
afterEach(async () => { await vi.dynamicImportSettled(); });

describe("nenBaoLoi — chống lặp theo queryKey", () => {
  it("lần đầu của một key thì báo", () => {
    expect(nenBaoLoi("a", 1_000, new Map())).toBe(true);
  });

  it("lặp lại trong cửa sổ thì im", () => {
    const bo = new Map<string, number>();
    expect(nenBaoLoi("a", 1_000, bo)).toBe(true);
    expect(nenBaoLoi("a", 1_000 + KHOANG_LAP_TOAST_MS - 1, bo)).toBe(false);
  });

  it("qua cửa sổ thì báo lại", () => {
    const bo = new Map<string, number>();
    nenBaoLoi("a", 1_000, bo);
    expect(nenBaoLoi("a", 1_000 + KHOANG_LAP_TOAST_MS, bo)).toBe(true);
  });

  it("key khác nhau không chặn nhau", () => {
    const bo = new Map<string, number>();
    expect(nenBaoLoi("a", 1_000, bo)).toBe(true);
    expect(nenBaoLoi("b", 1_000, bo)).toBe(true);
  });
});

describe("thongDiepLoiDoc — nói đúng hai điều người đọc cần biết", () => {
  it("42501 → nói rõ là chuyện QUYỀN, không phải 'không có dữ liệu'", () => {
    expect(thongDiepLoiDoc({ code: "42501", message: "RLS" })).toMatch(/quyền/i);
  });

  it("mất mạng → nói rõ là kết nối, để người dùng biết thử lại là có ích", () => {
    expect(thongDiepLoiDoc({ message: "TypeError: Failed to fetch" })).toMatch(/kết nối/i);
  });

  it("mất mạng trên Safari/iPhone ('Load failed') cũng là chuyện kết nối", () => {
    // Safari không nói "Failed to fetch" như Chrome — nó ném TypeError "Load failed".
    expect(thongDiepLoiDoc(new TypeError("Load failed"))).toMatch(/kết nối/i);
  });

  it("'upload failed' / 'download failed' KHÔNG bị đọc thành mất mạng", () => {
    expect(thongDiepLoiDoc(new Error("R2 upload failed (500): boom"))).not.toMatch(/kết nối/i);
    expect(thongDiepLoiDoc(new Error("Template download failed"))).not.toMatch(/kết nối/i);
  });

  it("42883 / 42703 có hướng khôi phục tải lại trang", () => {
    expect(thongDiepLoiDoc({ code: "42883" })).toMatch(/tải lại trang/i);
  });

  it("42883 / 42703 không đủ bằng chứng nói trang cũ hơn máy chủ", () => {
    expect(thongDiepLoiDoc({ code: "42883" })).not.toMatch(/cũ hơn|cập nhật|phiên bản/i);
  });

  it("40001 → bảo thử lại sau, KHÔNG đổ cho người dùng", () => {
    expect(thongDiepLoiDoc({ code: "40001" })).toMatch(/bận/i);
  });

  it("mã lạ → câu chung, không đoán bừa", () => {
    expect(thongDiepLoiDoc({ code: "XX999" })).toBe("Không tải được dữ liệu");
  });
});

describe("xuLyLoiQuery", () => {
  it.each(['errorDisplay','feedback'])('keeps %s inline errors in their region without another toast', key => {
    xuLyLoiQuery(new Error('failure'), truyVan(['salary'], {[key]:'inline'}), {bo:new Map()});
    expect(toastError).not.toHaveBeenCalled();
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });
  it("toast một lần cho mỗi queryKey, không nổ theo số lần refetch", async () => {
    const bo = new Map<string, number>();
    const loi = { code: "42501", message: "RLS" };
    for (let i = 0; i < 5; i += 1) xuLyLoiQuery(loi, truyVan(["areas"]), { bo, now: () => 1_000 });
    await vi.dynamicImportSettled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("hai key khác nhau vẫn được báo riêng", async () => {
    const bo = new Map<string, number>();
    xuLyLoiQuery({ message: "x" }, truyVan(["areas"]), { bo, now: () => 1_000 });
    xuLyLoiQuery({ message: "x" }, truyVan(["floors"]), { bo, now: () => 1_000 });
    await vi.dynamicImportSettled();
    expect(toastError).toHaveBeenCalledTimes(2);
  });

  it("meta.silent → KHÔNG toast", () => {
    xuLyLoiQuery({ message: "x" }, truyVan(["prefetch"], { silent: true }), {
      bo: new Map(),
      now: () => 1_000,
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("meta.silent vẫn báo lên reportBoundaryError (im với người dùng, không im với nhật ký)", () => {
    xuLyLoiQuery({ message: "x" }, truyVan(["prefetch"], { silent: true }), {
      bo: new Map(),
      now: () => 1_000,
    });
    expect(reportBoundaryError).toHaveBeenCalledTimes(1);
  });

  it("luôn gọi reportBoundaryError với một Error thật", () => {
    xuLyLoiQuery({ code: "42501", message: "RLS" }, truyVan(["areas"]), {
      bo: new Map(),
      now: () => 1_000,
    });
    const [loi] = reportBoundaryError.mock.calls[0];
    expect(loi).toBeInstanceOf(Error);
    expect(String(loi.message)).toContain("RLS");
  });

  it("dùng nhãn khu vực, không lộ khóa nội bộ hoặc ID", async () => {
    xuLyLoiQuery({ code: "42501", message: "RLS" }, truyVan(["areas", "private-org-uuid"]), {
      bo: new Map(),
      now: () => 1_000,
    });
    await vi.dynamicImportSettled();
    const [tieuDe, tuyChon] = toastError.mock.calls[0];
    expect(typeof tieuDe).toBe("string");
    expect(tieuDe.length).toBeGreaterThan(0);
    expect(String(tieuDe) + String(tuyChon?.description ?? "")).toContain("khu vực");
    expect(String(tieuDe) + String(tuyChon?.description ?? "")).not.toMatch(/areas|private-org-uuid/);
  });

  it("toast hỏng cũng KHÔNG ném — bộ báo lỗi không được tự làm sập app", () => {
    toastError.mockImplementation(() => {
      throw new Error("toast hỏng");
    });
    expect(() =>
      xuLyLoiQuery({ message: "x" }, truyVan(["areas"]), { bo: new Map(), now: () => 1_000 }),
    ).not.toThrow();
  });
});

it("offers a real retry action for the failed query instead of a nonexistent page button", async () => {
  const fetch = vi.fn().mockResolvedValue([]);
  xuLyLoiQuery(new Error('Failed to fetch'), { queryKey: ['rooms'], fetch }, { bo: new Map() });
  await vi.dynamicImportSettled();
  const options = toastError.mock.calls[0][1];
  expect(options.action.label).toBe('Tải lại');
  options.action.onClick();
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['Load failed','TypeError: Load failed'])('keeps latest-main Safari network feedback for %s', message => {
 expect(thongDiepLoiDoc({message})).toMatch(/kết nối/i);
});
it.each(['R2 upload failed (500)','Template download failed'])('does not classify a business upload/download error as Safari network failure: %s', message => {
 expect(thongDiepLoiDoc({message})).not.toMatch(/kết nối/i);
});
it('preserves the exported default read message for existing callers',async()=>{
 const {LOI_DOC_MAC_DINH}=await import('../QueryProvider');
 expect(thongDiepLoiDoc({code:'XX999'})).toBe(LOI_DOC_MAC_DINH);expect(LOI_DOC_MAC_DINH).toBe('Không tải được dữ liệu');
});
