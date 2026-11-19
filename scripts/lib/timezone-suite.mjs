// Existing app-unit specs dedicated to civil dates, periods and calendar arithmetic.
// New focused specs opt in with *.timezone.test.ts(x), including regressions split
// out of mixed suites. The normal app-unit manifest still owns test discovery.
export const TIMEZONE_TEST_FILES = Object.freeze([
  'src/components/contracts/detail/desktop/__tests__/invoicePeriodLabel.test.ts',
  'src/lib/__tests__/leaveDates.test.ts',
  'src/lib/__tests__/monthPeriod.test.ts',
  'src/lib/__tests__/ngayLocalKhongUTC.test.ts',
  'src/lib/__tests__/recurring.test.ts',
  'src/lib/__tests__/salaryPeriod.test.ts',
  'src/lib/__tests__/vnDate.test.ts',
  'src/lib/personal-tasks/calendar.test.ts',
  'src/lib/quickEntry/__tests__/dateWords.test.ts',
]);

export function isTimezoneTest(repoRelativePath) {
  return TIMEZONE_TEST_FILES.includes(repoRelativePath) || /\.timezone\.test\.tsx?$/.test(repoRelativePath);
}
