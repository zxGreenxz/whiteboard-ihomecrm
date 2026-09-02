// Đối chứng ÂM cho nửa tĩnh của `scripts/test-copilot-readonly-queries.mjs`.
//
// VÌ SAO CẦN MỘT FILE RIÊNG CHO ĐÚNG MỘT HÀM
//   Cửa chặn này vừa bị bắt quả tang là đo số không: nó đòi những lời gọi
//   PostgREST đã biến mất khi phần đọc chuyển sang RPC, nên `main()` ném trước
//   khi chạm PostgreSQL. Nó ném ỒN ÀO (`process.exitCode = 1`), nhưng chưa bao
//   giờ được nối vào CI nên không ai nghe thấy.
//
//   Bài học không phải "sửa regex". Nó là: một cửa chặn chưa từng được thấy
//   ĐỎ là một cửa chặn chưa được kiểm. Mọi khẳng định dưới đây đều đi theo cặp
//   — bản thật phải XANH, và một bản bị sửa đúng một chỗ phải ĐỎ.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertSourceContract,
  DIRECT_READ_EXEMPTIONS,
  REQUIRED_COPILOT_RPCS,
  TABLES_OFF_LIMITS_TO_THE_BROWSER,
  TOOL_SOURCE_FILES,
} from '../../../scripts/test-copilot-readonly-queries.mjs';

/** Nguồn thật, đọc y như harness đọc. */
function nguonThat(): Record<string, string> {
  return Object.fromEntries(
    TOOL_SOURCE_FILES.map((file: string) => [file, readFileSync(file, 'utf8')]),
  );
}

const WRITE_TOOLS = 'src/copilot/tools/writeTools.ts';

describe('harness readonly — pham vi quet', () => {
  it('quet CA writeTools.ts, khong chi hai file doc', () => {
    // Bỏ file ghi ra ngoài chính là thu hẹp bất biến cho vừa với mã: file duy
    // nhất được phép chạm mấy bảng này cũng là file duy nhất không ai soi.
    expect(TOOL_SOURCE_FILES).toContain(WRITE_TOOLS);
  });

  it('nguon THAT hom nay pass', () => {
    expect(assertSourceContract(nguonThat())).toBe(true);
  });

  it('mien tru cua writeTools la mot LOI GOI cu the, co ly do viet ra', () => {
    const entry = DIRECT_READ_EXEMPTIONS.find(
      (e: { file: string; table: string }) => e.file === WRITE_TOOLS,
    );
    expect(entry).toBeDefined();
    expect(entry.table).toBe('income_expenses');
    expect(entry.occurrences).toBe(1);
    expect(String(entry.reason).length).toBeGreaterThan(20);
  });
});

describe('harness readonly — doi chung am', () => {
  it('mot .from(contracts) MOI trong writeTools bi bat', () => {
    const nguon = nguonThat();
    nguon[WRITE_TOOLS] += "\nconst xx = supabase.from('contracts').select('id');\n";
    expect(() => assertSourceContract(nguon)).toThrow(/Direct browser read of contracts/);
  });

  it('mot .from(income_expenses) THU HAI trong writeTools bi bat, du bang da co mien tru', () => {
    // Đây là chỗ một allowlist theo file+bảng sẽ mù: nó đã "cho phép" cặp đó rồi.
    const nguon = nguonThat();
    nguon[WRITE_TOOLS] += "\nconst yy = supabase.from('income_expenses').select('*');\n";
    expect(() => assertSourceContract(nguon)).toThrow(/exemption covers 1 call\(s\)/);
  });

  it('mien tru da het tac dung thi bi bat, khong duoc nam lai lam cua mo san', () => {
    const nguon = nguonThat();
    nguon[WRITE_TOOLS] = nguon[WRITE_TOOLS].split(".from('income_expenses')").join(".from('nothing')");
    expect(() => assertSourceContract(nguon)).toThrow(/Stale exemption/);
  });

  it('doc thang bang bi cam trong file KHONG duoc mien tru thi bi bat', () => {
    for (const table of TABLES_OFF_LIMITS_TO_THE_BROWSER) {
      expect(() =>
        assertSourceContract({ 'src/copilot/tools/registry.ts': `supabase.from('${table}').select('*')` }),
      ).toThrow(new RegExp(`Direct browser read of ${table}`));
    }
  });

  it('go mot ten RPC khoi nguon thi bi bat', () => {
    for (const rpcName of REQUIRED_COPILOT_RPCS) {
      const con = REQUIRED_COPILOT_RPCS.filter((n: string) => n !== rpcName)
        .map((n: string) => `'${n}'`)
        .join('\n');
      expect(() => assertSourceContract({ 'x.ts': con })).toThrow(
        new RegExp(`no longer call ${rpcName}`),
      );
    }
  });

  it('khong doc duoc file nao la PHEP DO HONG, khong phai sach', () => {
    expect(() => assertSourceContract({})).toThrow(/no tool source was read/);
  });
});
