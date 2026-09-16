// Giả lập kích thước phần tử trong jsdom cho @tanstack/react-virtual.
//
// jsdom không có layout: `offsetHeight` của MỌI phần tử là 0, nên virtualizer
// thấy khung cuộn cao 0px và chỉ render đúng phần overscan — con số đó không
// nói gì về một khung cuộn thật. Gán chiều cao cố định (khung 600px, dòng 53px
// = ô `p-4` + một dòng chữ + viền) để phép đo "bao nhiêu <tr> nằm trong DOM"
// phản ánh cửa sổ hiển thị thật: ~12 dòng nhìn thấy + overscan.
//
// Cả `observeElementRect` (khung cuộn) lẫn `measureElement` (từng dòng) của
// virtual-core đều đọc `offsetHeight`, nên chỉ cần mock đúng một thuộc tính.
import { afterAll, beforeAll } from "vitest";

export const KHUNG_CAO = 600;
export const DONG_CAO = 53;

export function giaLapKichThuocKhungCuon() {
  let gocCao: PropertyDescriptor | undefined;
  let gocRong: PropertyDescriptor | undefined;

  beforeAll(() => {
    gocCao = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    gocRong = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === "TR" ? DONG_CAO : KHUNG_CAO;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get: () => 1000,
    });
  });

  afterAll(() => {
    if (gocCao) Object.defineProperty(HTMLElement.prototype, "offsetHeight", gocCao);
    if (gocRong) Object.defineProperty(HTMLElement.prototype, "offsetWidth", gocRong);
  });
}

/** Số `<tr>` đang nằm trong `<tbody>` của bảng đầu tiên trong `root`. */
export function demDongTrongBang(root: ParentNode, thuTuBang = 0): number {
  const bang = root.querySelectorAll("table")[thuTuBang];
  if (!bang) throw new Error(`không có bảng thứ ${thuTuBang} trong DOM`);
  return bang.querySelectorAll("tbody tr").length;
}
