import { describe, expect, it } from 'vitest';
import { assignSuites, crossRunnerConflicts, globToRegExp } from '../check-test-matrix.mjs';

// Gate check-test-matrix.mjs canh một thứ không có test nào khác canh được: file
// test nào thực sự chạy dưới runner nào. Bản thân nó sai thì mọi kết luận về độ
// phủ đều sai theo, mà không gì đỏ lên cả — nên chính nó cần test.

describe('globToRegExp', () => {
  it('`*` không vượt qua dấu /', () => {
    const re = globToRegExp('scripts/__tests__/*.test.mjs');
    expect(re.test('scripts/__tests__/a.test.mjs')).toBe(true);
    expect(re.test('scripts/__tests__/sub/a.test.mjs')).toBe(false);
  });

  it('`**/` khớp cả zero thư mục', () => {
    const re = globToRegExp('src/**/*.test.ts');
    expect(re.test('src/a.test.ts')).toBe(true);
    expect(re.test('src/lib/deep/a.test.ts')).toBe(true);
  });

  it('escape ký tự regex trong tên file — dấu chấm không được là wildcard', () => {
    const re = globToRegExp('a.test.mjs');
    expect(re.test('a.test.mjs')).toBe(true);
    expect(re.test('axtestxmjs')).toBe(false);
  });
});

describe('assignSuites — excludes', () => {
  const suites = [
    { id: 'app-unit', runner: 'vitest', includes: ['scripts/__tests__/**/*.test.mjs'] },
    { id: 'node-native', runner: 'node --test', includes: ['scripts/__tests__/network-center-*.test.mjs'] },
  ];
  const files = ['scripts/__tests__/normal.test.mjs', 'scripts/__tests__/network-center-x.test.mjs'];

  it('không có excludes thì app-unit ôm luôn file của node-native', () => {
    const { bySuite } = assignSuites(files, suites);
    expect(bySuite.get('app-unit')).toContain('scripts/__tests__/network-center-x.test.mjs');
  });

  it('có excludes thì file về đúng một suite', () => {
    const withEx = [{ ...suites[0], excludes: ['scripts/__tests__/network-center-*.test.mjs'] }, suites[1]];
    const { bySuite } = assignSuites(files, withEx);
    expect(bySuite.get('app-unit')).toEqual(['scripts/__tests__/normal.test.mjs']);
    expect(bySuite.get('node-native')).toEqual(['scripts/__tests__/network-center-x.test.mjs']);
  });

  it('excludes làm file thành MỒ CÔI nếu không suite nào khác nhận — phải báo, không được nuốt', () => {
    const onlyApp = [{ ...suites[0], excludes: ['scripts/__tests__/**'] }];
    const { orphans } = assignSuites(['scripts/__tests__/a.test.mjs'], onlyApp);
    expect(orphans).toEqual(['scripts/__tests__/a.test.mjs']);
  });
});

describe('crossRunnerConflicts', () => {
  // Đây là ca đã xảy ra thật 05/08/2026: 22 file `node:test` bị bước Vitest quét
  // phải và fail hàng loạt "No test suite found", trong khi matrix vẫn khai
  // chúng thuộc app-unit. Trước đó gate chỉ in ⚠ và vẫn xanh.
  const suites = [
    { id: 'app-unit', runner: 'vitest', includes: ['scripts/**/*.test.mjs'] },
    { id: 'node-native', runner: 'node --test', includes: ['scripts/**/nc-*.test.mjs'] },
  ];

  it('phát hiện file bị hai runner khác nhau cùng nhận', () => {
    const files = ['scripts/nc-a.test.mjs'];
    const { bySuite } = assignSuites(files, suites);
    const conflicts = crossRunnerConflicts(files, suites, bySuite);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].runners).toEqual(['vitest', 'node --test']);
  });

  it('KHÔNG báo khi hai suite trùng nhau nhưng cùng runner — trùng cùng runner là vô hại', () => {
    const same = [
      { id: 'a', runner: 'vitest', includes: ['scripts/**/*.test.mjs'] },
      { id: 'b', runner: 'vitest', includes: ['scripts/**/*.test.mjs'] },
    ];
    const files = ['scripts/x.test.mjs'];
    const { bySuite } = assignSuites(files, same);
    expect(crossRunnerConflicts(files, same, bySuite)).toEqual([]);
  });

  it('KHÔNG báo khi mỗi file chỉ thuộc một suite', () => {
    const files = ['scripts/plain.test.mjs'];
    const { bySuite } = assignSuites(files, suites);
    expect(crossRunnerConflicts(files, suites, bySuite)).toEqual([]);
  });
});
