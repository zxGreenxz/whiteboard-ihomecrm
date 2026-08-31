import { describe, it, expect } from "vitest";
import {
  classifySource,
  fingerprint,
  normalizeError,
  fromEarlyRecord,
  LIMITS,
} from "./errorTelemetry";

const ORIGIN = "https://ptcrm.vercel.app";

describe("classifySource", () => {
  it("xếp cầu nối WebView của bên thứ ba vào 'external'", () => {
    // Án lệ thật: gần như toàn bộ nhật ký lỗi là dòng này.
    expect(
      classifySource(
        { kind: "js", msg: "ReferenceError: Can't find variable: zaloJSV2" },
        ORIGIN,
      ),
    ).toBe("external");
    expect(
      classifySource({ kind: "js", msg: "fbNavigatorBridge is not defined" }, ORIGIN),
    ).toBe("external");
  });

  it("xếp 'Script error.' trần trụi (không nguồn) vào 'external'", () => {
    expect(classifySource({ kind: "js", msg: "Script error." }, ORIGIN)).toBe("external");
  });

  it("xếp tiện ích mở rộng vào 'external' dù nhìn từ nguồn hay từ stack", () => {
    expect(
      classifySource({ kind: "js", msg: "x", src: "chrome-extension://abc/inject.js" }, ORIGIN),
    ).toBe("external");
    expect(
      classifySource({ kind: "js", msg: "x", stack: "at f (moz-extension://a/b.js:1:1)" }, ORIGIN),
    ).toBe("external");
  });

  it("giữ lỗi JS cùng origin ở 'app'", () => {
    expect(
      classifySource(
        { kind: "js", msg: "TypeError: r.map is not a function", src: `${ORIGIN}/assets/x.js` },
        ORIGIN,
      ),
    ).toBe("app");
    expect(classifySource({ kind: "js", msg: "loi", src: "/assets/x.js" }, ORIGIN)).toBe("app");
  });

  it("lỗi JS từ file khác origin là 'external'", () => {
    expect(
      classifySource({ kind: "js", msg: "loi", src: "https://cdn.la.com/a.js" }, ORIGIN),
    ).toBe("external");
  });

  it("tài nguyên khác origin tải hỏng VẪN là lỗi của app", () => {
    // Ảnh phòng nằm trên CDN; hỏng ảnh là lỗi của mình, không được giấu đi.
    expect(
      classifySource(
        { kind: "resource", msg: "resource load failed: IMG", src: "https://cdn.r2.dev/p.jpg" },
        ORIGIN,
      ),
    ).toBe("app");
  });

  it("không suy đoán khi chưa biết origin", () => {
    expect(classifySource({ kind: "js", msg: "loi", src: "https://cdn.la.com/a.js" })).toBe("app");
  });
});

describe("fingerprint", () => {
  it("ổn định với cùng đầu vào và khác nhau khi đổi bất kỳ thành phần nào", () => {
    const base = { kind: "js" as const, msg: "loi A", src: "/a.js", line: 10 };
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, msg: "loi B" }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, line: 11 }));
    expect(fingerprint(base)).not.toBe(fingerprint({ ...base, kind: "resource" }));
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("normalizeError", () => {
  it("cắt độ dài và bỏ trường rỗng", () => {
    const m = normalizeError(
      {
        kind: "js",
        msg: "x".repeat(900),
        stack: "s".repeat(5000),
        src: "  ",
        where: "",
        href: `${ORIGIN}/${"p".repeat(500)}`,
      },
      ORIGIN,
    );
    expect(m.msg.length).toBe(LIMITS.msg);
    expect(m.stack?.length).toBe(LIMITS.stack);
    expect(m.href?.length).toBe(LIMITS.href);
    expect(m).not.toHaveProperty("src");
    expect(m).not.toHaveProperty("where");
  });

  it("luôn có msg, source, fp và n=1", () => {
    const m = normalizeError({ kind: "fetch_or_token", where: "usePhongTrong" }, ORIGIN);
    expect(m.msg).toBeTruthy();
    expect(m.source).toBe("app");
    expect(m.fp).toMatch(/^[0-9a-f]{8}$/);
    expect(m.n).toBe(1);
    expect(m.where).toBe("usePhongTrong");
  });

  it("bỏ số dòng/cột dị dạng thay vì ghi rác", () => {
    const m = normalizeError(
      { kind: "js", msg: "loi", line: Number.NaN, col: -3 } as never,
      ORIGIN,
    );
    expect(m).not.toHaveProperty("line");
    expect(m).not.toHaveProperty("col");
  });
});

describe("fromEarlyRecord", () => {
  it("đổi bản ghi thô của pt-boot.js sang đầu vào chuẩn", () => {
    const i = fromEarlyRecord({ k: "resource", msg: "img hong", src: "/a.png", ts: 123 });
    expect(i?.kind).toBe("resource");
    expect(i?.src).toBe("/a.png");
    expect(i?.ts).toBe(123);
  });

  it("loại lạ về 'js', bản ghi dị dạng trả null", () => {
    expect(fromEarlyRecord({ k: "linh tinh", msg: "a" })?.kind).toBe("js");
    expect(fromEarlyRecord(null)).toBeNull();
    expect(fromEarlyRecord(undefined)).toBeNull();
  });
});

describe("mốc thời gian client", () => {
  it("giữ epoch ms thật — cửa sổ số dòng/cột KHÔNG dùng được cho ts", () => {
    // Bản trước lọc ts bằng cùng hàm dùng cho line/col (trần 999.999.999) nên
    // Date.now() (~1,78e12) LUÔN bị vứt và cả đường ống ts thành mã chết.
    const bayGio = Date.now();
    expect(normalizeError({ kind: "js", msg: "loi", ts: bayGio }, ORIGIN).ts).toBe(bayGio);
  });

  it("loại mốc thời gian rác", () => {
    for (const rac of [0, 123, -1, Number.NaN, 9e15]) {
      expect(normalizeError({ kind: "js", msg: "loi", ts: rac }, ORIGIN)).not.toHaveProperty("ts");
    }
  });
});
