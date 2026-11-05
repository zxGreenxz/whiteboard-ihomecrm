// Sổ cho scripts/check-workflow-runner-pins.mjs.
//
// Gate này sinh ra từ một sự cố đo được: 05/11/2026 `ubuntu-latest` sang ảnh 26.04 và làm đỏ CI cả repo. Các ca đắt nhất ở đây:
//  - "nhãn nằm trong matrix / biểu thức" — đọc chuỗi `runs-on` thô thì `${{ matrix.os }}` trông như đã ghim;
//  - "viết khác hoa thường" — GitHub coi `Matrix.os`, `Vars.X`, `FromJson(…)` như viết thường, regex phân biệt hoa thường thì để lọt;
//  - "nhãn ghép lúc chạy" — `ubuntu-${{ 'latest' }}`, `format('ubuntu-{0}', 'latest')` không chứa `-latest` ở đâu trong file;
//  - "đột biến trên bản sao của cây thật" — chứng minh gate ĐỎ khi một nhãn trôi lọt vào đúng file workflow thật,
//    kể cả trạng thái `windows-latest` trước khi PR ghim `windows-2025-vs2026`.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import { danhGiaRunsOn, duyetRunsOn, duyetUsesNgoai, laNhanTroi, quetThuMuc, timNhanTroi } from '../check-workflow-runner-pins.mjs';

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
    expect(danh('strategy:\n  matrix:\n    os: [windows-latest]\nruns-on: ${{ matrix[github.event_name] }}'))
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

  it.each([
    '${{ github.event.client_payload.runner }}',
    "${{ github.event['client_payload'].runner }}",
    "${{ github['event']['client_payload']['runner'] }}",
    '${{ GITHUB.EVENT.CLIENT_PAYLOAD.runner }}',
    '${{ fromJSON(github.event.client_payload.labels) }}',
    "${{ github.event.client_payload.runner || 'ubuntu-24.04' }}",
    // Khoá viết trong ngoặc vuông không được giấu khỏi gate bằng chuỗi cố định: cùng cách với `inputs`.
    "${{ github['event']['inputs']['runner'] }}",
    "${{ github.event['inputs'].runner }}",
  ])('payload repository_dispatch / input dispatch %s không chứng minh được đã ghim', (runsOn) => {
    expect(danh(`runs-on: ${runsOn}`).some((l) => l.loai === 'ngoai')).toBe(true);
  });

  it('chữ client_payload nằm trong chuỗi cố định (so sánh điều kiện) thì không phải nguồn nhãn', () => {
    expect(danh("runs-on: ${{ github.event_name == 'client_payload' && 'ubuntu-24.04' || 'ubuntu-22.04' }}")).toEqual([]);
  });
});

describe('danhGiaRunsOn — GitHub không phân biệt hoa thường với tên context, hàm và khoá matrix', () => {
  const matrixCoLatest = (ref) => danh('strategy:\n  matrix:\n    os: [ubuntu-24.04, windows-latest]\nruns-on: ${{ ' + ref + ' }}');

  it.each(['Matrix.os', 'MATRIX.os', "Matrix['os']", "MATRIX['os']"])('%s đọc matrix như viết thường ⇒ thấy nhãn trôi', (ref) => {
    expect(matrixCoLatest(ref)).toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'matrix.os' }]);
  });

  it('MATRIX đứng riêng (tra khoá tính lúc chạy) vẫn xét cả matrix', () => {
    expect(matrixCoLatest('MATRIX[github.event_name]')).toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'strategy.matrix' }]);
    expect(matrixCoLatest('Matrix[github.event_name]')).toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'strategy.matrix' }]);
  });

  it('khoá matrix viết khác hoa thường vẫn tra đúng khoá, kể cả khoá ở include', () => {
    expect(danh('strategy:\n  matrix:\n    os: [windows-latest]\nruns-on: ${{ matrix.OS }}'))
      .toEqual([{ loai: 'troi', nhan: 'windows-latest', nguon: 'matrix.OS' }]);
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu-24.04]\n    include:\n      - OS: macos-latest\nruns-on: ${{ matrix.os }}'))
      .toEqual([{ loai: 'troi', nhan: 'macos-latest', nguon: 'matrix.os' }]);
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu-24.04]\nruns-on: ${{ matrix.OS }}')).toEqual([]);
  });

  it.each([
    '${{ Vars.RUNNER }}',
    '${{ VARS.RUNNER }}',
    '${{ Inputs.runner }}',
    '${{ INPUTS.runner }}',
    '${{ Needs.plan.outputs.runner }}',
    '${{ NEEDS.plan.outputs.r }}',
    '${{ Secrets.RUNNER }}',
    '${{ FromJson(needs.plan.outputs.labels) }}',
    '${{ fromjson(github.ref_name) }}',
    '${{ FROMJSON(github.ref_name) }}',
  ])('%s không chứng minh được đã ghim', (runsOn) => {
    expect(danh(`runs-on: ${runsOn}`).some((l) => l.loai === 'ngoai')).toBe(true);
  });

  it('fromJSON với chuỗi cố định vẫn là nhãn nằm trong file, viết hoa thường kiểu nào cũng vậy', () => {
    expect(danh("runs-on: ${{ FromJson('[\"ubuntu-24.04\"]') }}")).toEqual([]);
    expect(danh("runs-on: ${{ FROMJSON('[\"ubuntu-latest\"]') }}")).toEqual([{ loai: 'troi', nhan: 'ubuntu-latest' }]);
  });
});

describe('danhGiaRunsOn — nhãn ghép lúc chạy từ nhiều mảnh', () => {
  const ngoai = (runsOn) => danh('runs-on: ' + runsOn).filter((l) => l.loai === 'ngoai');

  it.each([
    "${{ format('ubuntu-{0}', 'latest') }}",
    "${{ format('ubuntu-{0}', '24.04') }}", // kết quả có thể đã ghim nhưng file không chứng minh được
    "${{ FORMAT('ubuntu-{0}', 'latest') }}",
    "${{ format ('ubuntu-{0}', 'latest') }}",
    "${{ join(fromJSON('[\"ubuntu\",\"latest\"]'), '-') }}",
    "${{ Join(fromJSON('[\"ubuntu\",\"24.04\"]'), '-') }}",
    "${{ github.event_name == 'push' && format('ubuntu-{0}', '24.04') || 'ubuntu-22.04' }}",
  ])('%s ⇒ không chứng minh được đã ghim', (runsOn) => {
    expect(ngoai(runsOn)).not.toEqual([]);
  });

  it('thông báo nêu biểu thức ghép', () => {
    expect(danh("runs-on: ${{ format('ubuntu-{0}', 'latest') }}"))
      .toEqual([{ loai: 'ngoai', chiTiet: "ghép nhãn lúc chạy bằng format/join: ${{ format('ubuntu-{0}', 'latest') }}" }]);
  });

  it.each([
    "ubuntu-${{ 'latest' }}",
    "ubuntu-${{ '24.04' }}",
    "${{ 'ubuntu' }}-24.04",
    "${{ 'ubuntu-' }}${{ 'latest' }}",
    "${{ 'ubuntu-' }} ${{ '24.04' }}",
  ])('chữ dính liền hoặc nhiều ${{ }} trong một nhãn: %s', (runsOn) => {
    expect(ngoai(runsOn)).not.toEqual([]);
  });

  it('thông báo nêu nhãn ghép', () => {
    expect(danh("runs-on: ubuntu-${{ 'latest' }}"))
      .toEqual([{ loai: 'ngoai', chiTiet: "nhãn ghép lúc chạy từ nhiều mảnh: ubuntu-${{ 'latest' }}" }]);
  });

  it('matrix.os cộng hậu tố ⇒ ghép lúc chạy, kể cả khi mọi giá trị matrix đều ghim', () => {
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu-24.04]\nruns-on: ${{ matrix.os }}-large'))
      .toEqual([{ loai: 'ngoai', chiTiet: 'nhãn ghép lúc chạy từ nhiều mảnh: ${{ matrix.os }}-large' }]);
    expect(danh('strategy:\n  matrix:\n    os: [ubuntu, windows]\nruns-on: ${{ matrix.os }}-latest'))
      .toEqual(expect.arrayContaining([{ loai: 'troi', nhan: '-latest' }, expect.objectContaining({ loai: 'ngoai' })]));
  });

  it('tra khoá matrix bằng format() vừa là ghép lúc chạy vừa xét cả matrix', () => {
    expect(danh("strategy:\n  matrix:\n    os: [windows-latest]\nruns-on: ${{ matrix[format('{0}', 'os')] }}"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ loai: 'ngoai' }),
        { loai: 'troi', nhan: 'windows-latest', nguon: 'strategy.matrix' },
      ]));
  });

  it('KHÔNG báo nhầm: `format(` trong chuỗi cố định, biểu thức nhiều dòng, mỗi phần tử mảng là một biểu thức riêng', () => {
    expect(danh("runs-on: ${{ github.event_name == 'format(x)' && 'ubuntu-24.04' || 'ubuntu-22.04' }}")).toEqual([]);
    expect(danh("runs-on: >-\n  ${{ github.event_name == 'push'\n  && 'ubuntu-24.04'\n  || 'ubuntu-22.04' }}")).toEqual([]);
    expect(danh("runs-on: |\n  ${{ github.event_name == 'push' && 'ubuntu-24.04' || 'ubuntu-22.04' }}\n")).toEqual([]);
    expect(danh("strategy:\n  matrix:\n    os: [ubuntu-24.04]\nruns-on: [self-hosted, '${{ matrix.os }}']")).toEqual([]);
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

describe('duyetUsesNgoai', () => {
  it('chỉ job gọi workflow ở repo khác; workflow cùng repo và `uses` của bước (action) không tính', () => {
    const doc = yaml.load([
      'jobs:',
      '  ngoai:',
      '    uses: owner/repo/.github/workflows/b.yml@main',
      '  noi-bo:',
      '    uses: ./.github/workflows/r.yml',
      '  thuong:',
      '    runs-on: ubuntu-24.04',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
    ].join('\n'));
    expect([...duyetUsesNgoai(doc)]).toEqual([{ duong: ['jobs', 'ngoai', 'uses'], uses: 'owner/repo/.github/workflows/b.yml@main' }]);
  });

  it('tài liệu không có jobs hợp lệ (file action, rỗng, mảng, jobs rỗng) thì không có gì', () => {
    for (const nguon of ['name: dung\nruns:\n  using: composite\n', '', '- a\n- b\n', 'jobs:\n', 'jobs: []\n', 'jobs:\n  a: null\n', 'jobs:\n  a: x\n']) {
      expect([...duyetUsesNgoai(yaml.load(nguon))]).toEqual([]);
    }
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

  it('job gọi workflow ở repo khác ⇒ lỗi "ngoai" tại jobs.<id>.uses, không tính vào số runs-on', () => {
    const goc = dungRepo({
      '.github/workflows/a.yml': workflow('ubuntu-24.04'),
      '.github/workflows/b.yml': 'name: y\non: push\njobs:\n  goi:\n    uses: owner/repo/.github/workflows/b.yml@main\n',
    });
    const kq = quetThuMuc(goc);
    expect(kq).toMatchObject({ soFile: 2, soRunsOn: 1, khongDo: [] });
    expect(kq.loi).toEqual([{
      file: '.github/workflows/b.yml',
      viTri: 'jobs.goi.uses',
      loai: 'ngoai',
      chiTiet: expect.stringContaining('owner/repo/.github/workflows/b.yml@main'),
    }]);
  });

  it('workflow dùng chung CÙNG repo được quét như file thường: callee ghim thì xanh, callee nhận runner qua inputs thì đỏ', () => {
    const goi = 'name: x\non: push\njobs:\n  goi:\n    uses: ./.github/workflows/r.yml\n    with:\n      runner: ubuntu-24.04\n';
    const calleeGhim = 'on: workflow_call\njobs:\n  b:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ok\n';
    const calleeNhan = 'on:\n  workflow_call:\n    inputs:\n      runner:\n        type: string\njobs:\n  b:\n    runs-on: ${{ inputs.runner }}\n    steps:\n      - run: echo ok\n';
    expect(quetThuMuc(dungRepo({ '.github/workflows/a.yml': goi, '.github/workflows/r.yml': calleeGhim })))
      .toEqual({ soFile: 2, soRunsOn: 1, loi: [], khongDo: [] });
    expect(quetThuMuc(dungRepo({ '.github/workflows/a.yml': goi, '.github/workflows/r.yml': calleeNhan })).loi)
      .toEqual([{ file: '.github/workflows/r.yml', viTri: 'jobs.b.runs-on', loai: 'ngoai', chiTiet: '${{ inputs.runner }}' }]);
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

  it('đỏ với nhãn viết khác hoa thường, nhãn ghép lúc chạy và job gọi workflow ở repo khác (mã 1, không phải 3 hay 0)', () => {
    const matrix = (os, ref) => `name: x\non: push\njobs:\n  build:\n    strategy:\n      matrix:\n        os: [${os}]\n    runs-on: \${{ ${ref} }}\n    steps:\n      - run: echo ok\n`;
    const dalo = {
      'Matrix.os chứa -latest': matrix('ubuntu-24.04, windows-latest', 'Matrix.os'),
      'Vars.X': workflow('${{ Vars.RUNNER }}'),
      'FromJson(needs…)': workflow('${{ FromJson(needs.plan.outputs.labels) }}'),
      'client_payload': workflow('${{ github.event.client_payload.runner }}'),
      'format()': workflow("${{ format('ubuntu-{0}', 'latest') }}"),
      'chữ dính liền': workflow("ubuntu-${{ 'latest' }}"),
    };
    for (const [ten, noiDung] of Object.entries(dalo)) {
      const r = chay(dungRepo({ '.github/workflows/a.yml': noiDung }));
      expect(r.status, ten).toBe(1);
      expect(r.stderr, ten).toContain('.github/workflows/a.yml › jobs.build.runs-on');
    }
  });

  it('job gọi workflow ở repo khác: thoát 1 (kể cả khi đó là job duy nhất), nêu job, workflow và cách sửa', () => {
    const goiNgoai = 'name: x\non: push\njobs:\n  goi:\n    uses: owner/repo/.github/workflows/b.yml@main\n';
    for (const files of [{ '.github/workflows/a.yml': goiNgoai }, { '.github/workflows/a.yml': goiNgoai, '.github/workflows/b.yml': workflow('ubuntu-24.04') }]) {
      const r = chay(dungRepo(files));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('.github/workflows/a.yml › jobs.goi.uses');
      expect(r.stderr).toContain('owner/repo/.github/workflows/b.yml@main');
      expect(r.stderr).toContain('./.github/workflows/');
    }
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

    it('`Matrix.os` viết hoa chứa nhãn trôi trong workflow thật ⇒ đỏ', () => {
      const goc = banSao();
      sua(goc, 'external-controls.yml', 'runs-on: ubuntu-24.04', 'strategy:\n      matrix:\n        os: [ubuntu-24.04, macos-latest]\n    runs-on: ${{ Matrix.os }}');
      const r = chay(goc);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('macos-latest');
    });

    it('nhãn ghép lúc chạy trong workflow thật ⇒ đỏ', () => {
      const goc = banSao();
      sua(goc, 'external-controls.yml', 'runs-on: ubuntu-24.04', "runs-on: ${{ format('ubuntu-{0}', 'latest') }}");
      const r = chay(goc);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('external-controls.yml');
      expect(r.stderr).toContain('format/join');
    });

    it('chuyển một job sang workflow dùng chung ở repo khác ⇒ đỏ (runner do bên kia chọn)', () => {
      const goc = banSao();
      sua(goc, 'external-controls.yml', 'runs-on: ubuntu-24.04', 'uses: owner/repo/.github/workflows/b.yml@main');
      const r = chay(goc);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('external-controls.yml › jobs.external-controls.uses');
    });
  });
});
