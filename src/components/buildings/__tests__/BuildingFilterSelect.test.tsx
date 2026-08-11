import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  useBuildings: vi.fn(() => ({ data: [] })),
}));

vi.mock("@/hooks/useBuildings", () => ({
  useBuildings: harness.useBuildings,
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: (): null => null,
}));

import { BuildingFilterSelect } from "../BuildingFilterSelect";

function renderSelect(
  buildings?: { id: string; name: string }[],
  extra?: { includeVirtual?: boolean },
) {
  return renderToStaticMarkup(
    createElement(BuildingFilterSelect, {
      value: [],
      onChange: vi.fn(),
      ...(buildings === undefined ? {} : { buildings }),
      ...extra,
    }),
  );
}

// Hai nhóm test dưới đây cố ý dùng `objectContaining` thay vì so khớp TOÀN BỘ
// đối số. Lý do là một án lệ có thật: commit 5b14e9a0 thêm option `includeVirtual`
// vào component, và hai test này — vốn chỉ nói về cờ `enabled` — vỡ theo dù điều
// chúng kiểm không hề đổi. Chúng nằm đỏ như vậy suốt, và test đỏ mà ai cũng biết
// là "đỏ sẵn" thì mất luôn tác dụng cảnh báo.
//
// Cách chữa không phải nới lỏng kiểm tra, mà là tách theo MỐI QUAN TÂM: mỗi test
// khẳng định đúng một option, nên chỉ đỏ khi chính option đó sai. Option mới thêm
// vào sau này sẽ có test riêng của nó, thay vì làm vỡ test của người khác.
describe("BuildingFilterSelect", () => {
  beforeEach(() => {
    harness.useBuildings.mockClear();
  });

  it("disables the fallback query when buildings are provided", () => {
    renderSelect([]);

    expect(harness.useBuildings).toHaveBeenCalledOnce();
    expect(harness.useBuildings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("keeps the fallback query enabled when buildings are omitted", () => {
    renderSelect();

    expect(harness.useBuildings).toHaveBeenCalledOnce();
    expect(harness.useBuildings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  // Hành vi do 5b14e9a0 thêm vào và ship KHÔNG kèm test nào. Toà ảo là bucket gom
  // thu/chi không thuộc toà vật lý, nên bật nhầm ở màn quản lý toà nhà sẽ hiện ra
  // một "toà" không có thật, còn tắt nhầm ở ô lọc thu chi thì giấu mất tiền.
  it("mặc định KHÔNG lấy toà ảo", () => {
    renderSelect();

    expect(harness.useBuildings).toHaveBeenCalledWith(
      expect.objectContaining({ includeVirtual: false }),
    );
  });

  it("chuyển tiếp includeVirtual xuống useBuildings khi được bật", () => {
    renderSelect(undefined, { includeVirtual: true });

    expect(harness.useBuildings).toHaveBeenCalledWith(
      expect.objectContaining({ includeVirtual: true }),
    );
  });
});
