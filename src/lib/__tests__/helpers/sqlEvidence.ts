import { boChuThichSql } from "../../../../scripts/lib/bo-chu-thich.mjs";

/** Local evidence scanner: comments are not executable SQL. Dollar-quoted
 * AS/DO/EXECUTE bodies contain code; other dollar quotes and SQL literals do not.
 * Mask literals before the shared helper, whose comment rules are not lexical.
 * This only prepares test input; it never rewrites a migration on disk. */
export function sqlEvidence(source: string): string {
  let prefix = "__SQL_EVIDENCE_LITERAL_";
  while (source.includes(prefix)) prefix += "_";
  const literals: string[] = [];
  const bodies: string[] = [];
  let masked = "";
  let i = 0;
  const literal = (end: number) => {
    masked += `${prefix}${literals.length}__`;
    literals.push(source.slice(i, end));
    i = end;
  };
  while (i < source.length) {
    if (source.startsWith("--", i)) {
      const end = source.indexOf("\n", i);
      masked += " ";
      i = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      masked += " ";
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else { if (source[i] === "\n") masked += "\n"; i++; }
      }
      if (depth) throw new Error("Unclosed SQL evidence comment");
    } else if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      const escaped = quote === "'" && /(?:^|[^\w$])[eE]$/.test(source.slice(0, i));
      let end = i + 1;
      let closed = false;
      while (end < source.length) {
        if (escaped && source[end] === "\\") { end += 2; continue; }
        if (source[end] === quote) {
          if (source[end + 1] === quote) { end += 2; continue; }
          end++; closed = true; break;
        }
        end++;
      }
      if (!closed) throw new Error("Unclosed SQL evidence literal");
      literal(end);
    } else {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i))?.[0];
      if (tag && bodies.at(-1) === tag) {
        bodies.pop(); masked += tag; i += tag.length;
      } else if (tag && /\b(?:AS|DO|EXECUTE)\s*$/i.test(masked)) {
        bodies.push(tag); masked += tag; i += tag.length;
      } else if (tag) {
        const end = source.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error("Unclosed SQL evidence dollar literal");
        literal(end + tag.length);
      } else {
        masked += source[i++];
      }
    }
  }
  if (bodies.length) throw new Error("Unclosed SQL evidence body");
  return boChuThichSql(masked).replace(new RegExp(`${prefix}(\\d+)__`, "g"),
    (_: string, index: string) => literals[Number(index)]);
}
