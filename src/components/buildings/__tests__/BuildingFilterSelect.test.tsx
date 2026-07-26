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
  SearchableSelect: () => null,
}));

import { BuildingFilterSelect } from "../BuildingFilterSelect";

function renderSelect(buildings?: { id: string; name: string }[]) {
  return renderToStaticMarkup(
    createElement(BuildingFilterSelect, {
      value: [],
      onChange: vi.fn(),
      ...(buildings === undefined ? {} : { buildings }),
    }),
  );
}

describe("BuildingFilterSelect", () => {
  beforeEach(() => {
    harness.useBuildings.mockClear();
  });

  it("disables the fallback query when buildings are provided", () => {
    renderSelect([]);

    expect(harness.useBuildings).toHaveBeenCalledOnce();
    expect(harness.useBuildings).toHaveBeenCalledWith({ enabled: false });
  });

  it("keeps the fallback query enabled when buildings are omitted", () => {
    renderSelect();

    expect(harness.useBuildings).toHaveBeenCalledOnce();
    expect(harness.useBuildings).toHaveBeenCalledWith({ enabled: true });
  });
});
