import { describe, expect, it } from "vitest";
import { sqlEvidence } from "./helpers/sqlEvidence";

describe("local live SQL evidence scanner", () => {
  it("inline comment cannot provide the missing audit INSERT", () => {
    const code = sqlEvidence("BEGIN\n NULL; -- INSERT INTO public.contract_terminations (id) VALUES (v_audit.id);\nEND;");
    expect(code).not.toMatch(/INSERT\s+INTO\s+public\.contract_terminations/i);
    expect(code).toContain("NULL;");
  });
  it.each([
    "'value -- still a literal'", "'value /* still a literal */'",
    "'it''s -- quoted'", '"identifier--quoted"', "E'it\\'s -- escaped'",
    "'first\n-- second\n/* third */'", "$value$-- literal /* value */$value$",
  ])("preserves literal bytes: %s", (value) => {
    expect(sqlEvidence(`SELECT ${value}; -- real comment`).trimEnd()).toBe(`SELECT ${value};`);
  });
  it("scans nested executable dollar bodies, preserving their quoted values", () => {
    const sql = "DO $outer$ BEGIN EXECUTE $install$ CREATE FUNCTION f() RETURNS void AS $function$ BEGIN PERFORM '-- value'; NULL; -- INSERT INTO bad\nEND; $function$ LANGUAGE plpgsql; $install$; END $outer$;";
    const code = sqlEvidence(sql);
    expect(code).toContain("PERFORM '-- value';");
    expect(code).not.toContain("INSERT INTO bad");
    expect(code).toContain("$install$;");
  });
  it("removes nested block and full-line comments without joining tokens", () => {
    expect(sqlEvidence("SELECT/* outer /* nested */ end */1;\n-- hidden\nSELECT 2;"))
      .toBe("SELECT 1;\n \nSELECT 2;");
  });
  it.each(["SELECT 'unterminated", "/* unterminated", "DO $body$ BEGIN", "SELECT $value$unterminated"])(
    "fails closed on truncated evidence: %s", (sql) => expect(() => sqlEvidence(sql)).toThrow(/Unclosed SQL evidence/),
  );
});
