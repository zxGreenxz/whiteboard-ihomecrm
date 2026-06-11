import type { AnalysisFilters } from "./types";
import { colorAt, COLOR_INCOME } from "./utils";
import { TypeBreakdownSection } from "./TypeBreakdownSection";

interface Props {
  filters: AnalysisFilters;
}

/** Tab Doanh thu — cơ cấu nguồn thu KQKD theo hạng mục & toà nhà. */
export function RevenueTab({ filters }: Props) {
  return (
    <TypeBreakdownSection
      filters={filters}
      side="INCOME"
      mainColor={COLOR_INCOME}
      colorFn={colorAt}
      invert={false}
      noun="thu"
      exportPrefix="doanh-thu"
    />
  );
}
