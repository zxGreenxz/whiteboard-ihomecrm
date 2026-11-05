// Sổ cho scripts/check-workflow-runner-pins.mjs.
//
// Gate này sinh ra từ một sự cố đo được: 05/11/2026 `ubuntu-latest` sang ảnh 26.04 và làm đỏ CI cả repo. Hai ca đắt nhất ở đây:
//  - "nhãn nằm trong matrix / biểu thức" — đọc chuỗi `runs-on` thô thì `${{ matrix.os }}` trông như đã ghim;
//  - "đột biến trên bản sao của cây thật" — chứng minh gate ĐỎ khi một nhãn trôi lọt vào đúng file workflow thật,
//    kể cả trạng thái `windows-latest` trước khi PR ghim `windows-2025-vs2026`.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import { danhGiaRunsOn, duyetRunsOn, laNhanTroi, quetThuMuc, timNhanTroi } from '../check-workflow-runner-pins.mjs';

const GOC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(GOC, 'scripts', 'check-workflow-runner-pins.mjs');

const tam = [];
afterAll(() => { for (const d of tam) rmSync(d, { recursive: true, force: true }); });

/** Dựng một repo giả: { 'đường/dẫn': 'nội dung' } ⇒ thư mục tạm. */
function dungRepo(files) {
  const goc = mkdtempSync(join(tmpdir(), 'runner-pins-'));
  tam.push(goc);
  for (const [duong, noiDung] of Object.entries(files)) {
    mkdirSync(dirname(join(goc, duong)), { recursive: true });
    writeFileSync(join(goc, duong), noiDung);
  }
  return goc;
}
const chay = (goc) => spawnSync(process.execPath, [SCRIPT, '--root', goc], { encoding: 'utf8' });
const workflow = (runsOn) => `name: x\non: push\njobs:\n  build:\n    runs-on: ${runsOn}\n    steps:\n      - run: echo ok\n`;
/** Job dạng YAML ⇒ kết quả đánh giá runs-on của chính job đó. */
const danh = (job) => { const j = yaml.load(job); return danhGiaRunsOn(j['runs-on'], j); };

describe('laNhanTroi / timNhanTroi', () => {
  it.each(['ubuntu-latest', 'windows-latest', 'macos-latest', 'macos-latest-large', 'UBUNTU-LATEST'])('%s là nhãn trôi', (nhan) => {
    expect(laNhanTroi(nhan)).toBe(true);
  });

  it.each(['ubuntu-24.04', 'ubuntu-26.04', 'windows-2025', 'windows-2025-vs2026', 'macos-26', 'ubuntu-slim', 'self-hosted', 'latest', 'ubuntu-latestx'])('%s đã ghim', (nhan) => {
    expect(laNhanTroi(nhan)).toBe(false);
  });

  it('thấy nhãn nằm trong biểu thức, bỏ qua phần còn lại', () => {
    expect(timNhanTroi("${{ github.event_name == 'push' && 'ubuntu-latest' || 'ubuntu-24.04' }}")).toEqual(['ubuntu-latest']);
  });
});

describe('danhGiaRunsOn — các dạng runs-on', () => {
  it('nhãn cụ thể thì sạch', () => {
    expect(danh('runs-on: ubuntu-24.04')).toEqual([]);
    expect(danh('runs-on: windows-2025-vs2026')).toEqual([]);
  });

  it('nhãn đơn, có hay không có nháy', () => {
    expect(danh('runs-on: ubuntu-latest')).toEqual([{ loai: 'troi', nhan: 'ubuntu-latest' }]);
    expect(danh('runs-on: "windows-latest"')).toEqual([{ loai: 'troi', nhan: 'windows-latest' }]);
    expect(danh("runs-on: 'macos-latest'")).toEqual([{ loai: 'troi', nhan: 'macos-latest' }]);
  });

  it('mảng nhãn (dòng và khối)', () => {
    expect(danh('runs-on: [self-hosted, ubuntu-latest]')).toEqual([{ loai: 'troi', nhan: 'ubuntu-latest' }]);
    expect(danh('runs-on:\n  - self-hosted\n  - linux\n  - macos-latest-large')).toEqual([{ loai: 'troi', nhan: 'macos-latest-large' }]);
    expect(danh('runs-on: [self-hosted, linux]')).toEqual([]);
  });

  it('dạng { group, labels }', () => {
    expect(danh('runs-on:\n  group: runners\n  labels: ubuntu-latest')).toEqual([{ loai: 'troi', nhan: 'ubuntu-latest' }]);
    expect(danh('runs-on:\n  group: runners\n  labels: [ubuntu-24.04]')).toEqual([]);
  });

  it('nhãn trôi nằm trong biểu thức điều kiện', () => {
    expect(danh("runs-on: ${{ github.event_name == 'push' && 'ubuntu-latest' || 'ubuntu-24.04' }}"))
      .toEqual([{ loai: 'troi', nhan: 'ubuntu-latest' }]);
  });

  it('biểu thức mà cả hai nhánh đều là nhãn cụ thể thì sạch (điều kiện theo github.* là hợp lệ)', () => {
    expect(danh("runs-on: ${{ github.event_name == 'push' && 'ubuntu-24.04' || 'windows-2025-vs2026' }}")).toEqual([]);
    expect(danh("runs-on: ${{ fromJSON('[\"ubuntu-24.04\"]') }}")).toEqual([]);
    expect(danh("runs-on: ${{ fromJSON('[\"ubuntu-latest\"]') }}")).toEqual([{ loai: 'troi', nhan: 'ubuntu-latest' }]);
  });
});

describe('danhGiaRunsOn — matrix', () => {
  it('matrix toàn nhãn cụ thể thì sạch', () => {
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu-24.04, windows-2025-vs2026]\nruns-on: ${{ matrix.os }}')).toEqual([]);
  });

  it('nhãn trôi trong mảng của khoá được dùng', () => {
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu-24.04, windows-latest]\nruns-on: ${{ matrix.os }}'))
      .toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'matrix.os' }]);
  });

  it('nhãn trôi trong include', () => {
    const job = 'strategy:\n  matrix:\n    os: [ubuntu-24.04]\n    include:\n      - os: macos-latest\n        extra: x\nruns-on: ${{ matrix.os }}';
    expect(danh(job)).toEqual([{ loai: 'troi', nhan: 'macos-latest', nguon: 'matrix.os' }]);
  });

  it('khoá thêm hoàn toàn từ include cũng được đọc', () => {
    expect(danh('strategy:\n  matrix:\n    include:\n      - runner: ubuntu-latest\nruns-on: ${{ matrix.runner }}'))
      .toEqual([{ loai: 'troi', nhan: 'ubuntu-latest', nguon: 'matrix.runner' }]);
  });

  it("cú pháp matrix['os']", () => {
    expect(danh("strategy:\n  matrix:\n    os: [windows-latest]\nruns-on: ${{ matrix['os'] }}"))
      .toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'matrix.os' }]);
  });

  it('chỉ đọc khoá runs-on dùng: `-latest` ở khoá khác không phải lỗi', () => {
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu-24.04]\n    image: [alpine-latest]\nruns-on: ${{ matrix.os }}')).toEqual([]);
  });

  it('tra khoá tính lúc chạy ⇒ xét cả matrix', () => {
    expect(danh("strategy:\n  matrix:\n    os: [windows-latest]\nruns-on: ${{ matrix[format('{0}', 'os')] }}"))
      .toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'strategy.matrix' }]);
  });

  it('matrix động, thiếu khoá hoặc giá trị là biểu thức ⇒ không chứng minh được', () => {
    expect(danh("strategy:\n  matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}\nruns-on: ${{ matrix.os }}"))
      .toEqual([expect.objectContaining({ loai: 'ngoai' })]);
    expect(danh('strategy:\n  matrix:\n    node: [22]\nruns-on: ${{ matrix.os }}')).toEqual([expect.objectContaining({ loai: 'ngoai' })]);
    expect(danh('runs-on: ${{ matrix.os }}')).toEqual([expect.objectContaining({ loai: 'ngoai' })]);
    expect(danh("strategy:\n  matrix:\n    os: ${{ fromJSON(needs.plan.outputs.os) }}\nruns-on: ${{ matrix.os }}"))
      .toEqual([expect.objectContaining({ loai: 'ngoai' })]);
  });
});

describe('danhGiaRunsOn — nhãn lấy từ ngoài file', () => {
  it.each([
    '${{ vars.RUNNER }}',
    '${{ inputs.runner }}',
    '${{ github.event.inputs.runner }}',
    '${{ needs.plan.outputs.runner }}',
    '${{ secrets.RUNNER }}',
    '${{ fromJSON(needs.plan.outputs.labels) }}',
    "${{ inputs.runner || 'ubuntu-24.04' }}",
  ])('%s không chứng minh được đã ghim', (runsOn) => {
    expect(danh(`runs-on: ${runsOn}`).some((l) => l.loai === 'ngoai')).toBe(true);
  });

  it('thông báo nêu đúng biểu thức gây lỗi', () => {
    expect(danh('runs-on: ${{ vars.RUNNER }}')).toEqual([{ loai: 'ngoai', chiTiet: '${{ vars.RUNNER }}' }]);
  });
});

describe('duyetRunsOn', () => {
  it('tìm runs-on ở mọi job với đường dẫn đầy đủ', () => {
    const doc = yaml.load('jobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: y\n');
    expect([...duyetRunsOn(doc)].map((r) => r.duong.join('.'))).toEqual(['jobs.a.runs-on', 'jobs.b.runs-on']);
  });

  it('tìm cả runs-on ở độ sâu bất kỳ (file action)', () => {
    const doc = yaml.load('name: a\nrouting:\n  - runs-on: ubuntu-latest\n');
    expect([...duyetRunsOn(doc)].map((r) => r.duong.join('.'))).toEqual(['routing.0.runs-on']);
  });

  it('không tính `runs-on` nằm trong chuỗi lệnh hay trong comment', () => {
    const doc = yaml.load('# runs-on: ubuntu-latest\njobs:\n  a:\n    runs-on: ubuntu-24.04 # trước đây ubuntu-latest\n    steps:\n      - run: |\n          echo "runs-on: ubuntu-latest"\n');
    const thay = [...duyetRunsOn(doc)];
    expect(thay).toHaveLength(1);
    expect(danhGiaRunsOn(thay[0].runsOn, thay[0].job)).toEqual([]);
  });
});

describe('quetThuMuc', () => {
  it('cây sạch: đếm đúng file, runs-on, không lỗi', () => {
    const goc = dungRepo({ '.github/workflows/a.yml': workflow('ubuntu-24.04'), '.github/workflows/b.yaml': workflow('windows-2025-vs2026') });
    expect(quetThuMuc(goc)).toEqual({ soFile: 2, soRunsOn: 2, loi: [], khongDo: [] });
  });

  it('nhãn trôi trong workflow: nêu file, vị trí, nhãn', () => {
    const goc = dungRepo({ '.github/workflows/a.yml': workflow('ubuntu-latest') });
    expect(quetThuMuc(goc).loi).toEqual([{ file: '.github/workflows/a.yml', viTri: 'jobs.build.runs-on', loai: 'troi', nhan: 'ubuntu-latest' }]);
  });

  it('đuôi .yaml cũng bị quét', () => {
    const goc = dungRepo({ '.github/workflows/a.yaml': workflow('windows-latest') });
    expect(quetThuMuc(goc).loi.map((l) => l.nhan)).toEqual(['windows-latest']);
  });

  it('quét cả .github/actions (nếu có runs-on) và thư mục con', () => {
    const goc = dungRepo({
      '.github/workflows/a.yml': workflow('ubuntu-24.04'),
      '.github/actions/dung/action.yml': 'name: dung\nruns-on: macos-latest\n',
    });
    const kq = quetThuMuc(goc);
    expect(kq.soRunsOn).toBe(2);
    expect(kq.loi).toEqual([{ file: '.github/actions/dung/action.yml', viTri: 'runs-on', loai: 'troi', nhan: 'macos-latest' }]);
  });

  it('action composite không có runs-on thì không làm đỏ (và không làm sai số đếm)', () => {
    const goc = dungRepo({
      '.github/workflows/a.yml': workflow('ubuntu-24.04'),
      '.github/actions/dung/action.yml': 'name: dung\nruns:\n  using: composite\n  steps:\n    - run: echo ok\n      shell: bash\n',
    });
    expect(quetThuMuc(goc)).toMatchObject({ soFile: 2, soRunsOn: 1, loi: [], khongDo: [] });
  });

  it('file nhiều tài liệu YAML vẫn được đọc hết', () => {
    const goc = dungRepo({ '.github/workflows/a.yml': workflow('ubuntu-24.04') + '---\n' + workflow('ubuntu-latest') });
    expect(quetThuMuc(goc).loi.map((l) => l.nhan)).toEqual(['ubuntu-latest']);
  });

  it('YAML hỏng hoặc thiếu .github/workflows ⇒ khongDo, không phải "sạch"', () => {
    expect(quetThuMuc(dungRepo({ '.github/workflows/a.yml': 'jobs: [\n' })).khongDo[0]).toMatch(/a\.yml: không parse được YAML/);
    expect(quetThuMuc(dungRepo({ 'README.md': 'x' })).khongDo[0]).toMatch(/không thấy thư mục \.github\/workflows/);
  });
});

describe('CLI', () => {
  it('xanh: thoát 0 và nói đã kiểm bao nhiêu', () => {
    const r = chay(dungRepo({ '.github/workflows/a.yml': workflow('ubuntu-24.04') }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 runs-on trong 1 file YAML');
  });

  it('đỏ: thoát 1, nêu file + nhãn + cách sửa', () => {
    const r = chay(dungRepo({ '.github/workflows/a.yml': workflow('ubuntu-latest') }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('.github/workflows/a.yml › jobs.build.runs-on');
    expect(r.stderr).toContain('nhãn trôi `ubuntu-latest`');
    expect(r.stderr).toContain('Image:');
  });

  it('không đo được: thoát 3 (không có runs-on nào, YAML hỏng, thiếu thư mục, thiếu giá trị --root)', () => {
    expect(chay(dungRepo({ '.github/workflows/a.yml': 'name: x\non: push\njobs: {}\n' })).status).toBe(3);
    expect(chay(dungRepo({ '.github/workflows/a.yml': 'jobs: [\n' })).status).toBe(3);
    expect(chay(dungRepo({ 'README.md': 'x' })).status).toBe(3);
    expect(spawnSync(process.execPath, [SCRIPT, '--root'], { encoding: 'utf8' }).status).toBe(3);
  });
});

describe('trạng thái thật của repo', () => {
  it('mọi runs-on trong .github đều đã ghim (sàn số đếm chống xanh rỗng)', () => {
    const kq = quetThuMuc(GOC);
    expect(kq.khongDo).toEqual([]);
    expect(kq.loi).toEqual([]);
    expect(kq.soRunsOn).toBeGreaterThanOrEqual(10);
  });

  describe('đột biến trên bản sao của .github thật', () => {
    const banSao = () => {
      const goc = mkdtempSync(join(tmpdir(), 'runner-pins-that-'));
      tam.push(goc);
      cpSync(join(GOC, '.github'), join(goc, '.github'), { recursive: true });
      return goc;
    };
    const sua = (goc, tep, tu, den) => {
      const duong = join(goc, '.github', 'workflows', tep);
      const noiDung = readFileSync(duong, 'utf8');
      expect(noiDung, `${tep} phải chứa "${tu}" để đột biến có nghĩa`).toContain(tu);
      writeFileSync(duong, noiDung.replace(tu, () => den)); // hàm thay: chuỗi thay có `$` (vd `${{ … }}`) không bị hiểu thành mẫu
    };

    it('bản sao nguyên vẹn xanh', () => {
      expect(chay(banSao()).status).toBe(0);
    });

    it('thêm một `runs-on: ubuntu-latest` vào workflow thật ⇒ đỏ', () => {
      const goc = banSao();
      sua(goc, 'external-controls.yml', 'runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest');
      const r = chay(goc);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('external-controls.yml');
      expect(r.stderr).toContain('ubuntu-latest');
    });

    it('trả job Windows về `windows-latest` (trạng thái trước PR ghim) ⇒ đỏ', () => {
      const goc = banSao();
      sua(goc, 'network-center-validation.yml', 'runs-on: windows-2025-vs2026', 'runs-on: windows-latest');
      const r = chay(goc);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('network-center-validation.yml');
      expect(r.stderr).toContain('windows-latest');
    });

    it('đẩy nhãn trôi vào matrix của workflow thật ⇒ đỏ', () => {
      const goc = banSao();
      sua(goc, 'external-controls.yml', 'runs-on: ubuntu-24.04', 'strategy:\n      matrix:\n        os: [ubuntu-24.04, macos-latest]\n    runs-on: ${{ matrix.os }}');
      const r = chay(goc);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('macos-latest');
    });
  });
});
