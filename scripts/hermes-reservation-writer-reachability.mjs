// Static call-site proof for the canonical reservation receipt, not an allowlist
// for ie_compat_insert_v2. Its ordinary branches and dependencies remain scanned.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const digest = sql => createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex');
export const RESERVATION_RECEIPT_CALLER = 'app_private.create_reservation_source_receipt_v1';
export const COMPAT_RECEIPT_WRITER = 'public.ie_compat_insert_v2';

// Inputs have already passed the SQL comment stripper. These whole-definition
// pins cover the receipt allowlist, fixed jsonb builder, branch condition and all
// writes. Any merge/variable payload, new call, renamed guard or changed branch
// needs review; the proof must not generalize to another caller or future body.
const CALLER_SHA256 = 'cd1b06e48ddecc45c2af8521ad907dee2f06b2febe7b630e78cd947037ad11ab';
const WRITER_SHA256 = '72476364bb42483a7c31945ee2ae226b4f5cd85753b2d6dfd1ca6fb5f4d4788a';

// Only used after the exact pins match. Ignore single/double quoted tokens while
// matching nested PL/pgSQL IF/END IF. Preserve the outer ELSE (ordinary path).
function discardFalseIf(sql, condition) {
  const head = `IF ${condition} THEN`, start = sql.indexOf(head);
  assert(start >= 0, `reviewed unreachable branch missing: ${condition}`);
  const tokenCode = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"/g, value => ' '.repeat(value.length));
  const tokens = /\bEND\s+IF\b|\bIF\b|\bELSIF\b|\bELSE\b/g;
  tokens.lastIndex = start + head.length;
  let depth = 1, ordinary = null;
  for (let token; (token = tokens.exec(tokenCode));) {
    if (token[0] === 'IF') depth++;
    else if (/^END/.test(token[0])) {
      depth--;
      if (!depth) {
        const end = token.index + token[0].length;
        assert.equal(sql[end], ';', 'reviewed IF statement terminator');
        return sql.slice(0, start) + (ordinary === null ? '' : sql.slice(ordinary, token.index)) + sql.slice(end + 1);
      }
    } else if (depth === 1) {
      assert.equal(token[0], 'ELSE', 'reviewed unreachable branch has no ELSIF');
      assert.equal(ordinary, null, 'one outer ELSE');
      ordinary = token.index + token[0].length;
    }
  }
  assert.fail('reviewed unreachable branch has no END IF');
}

export function ordinaryReservationReceiptWriter(caller, writer) {
  assert.equal(digest(caller), CALLER_SHA256, 'exact reservation receipt builder/allowlist call-site proof');
  assert.equal(digest(writer), WRITER_SHA256, 'exact shared receipt writer branch proof');
  // p_row is a newly built object with no draft marker, never merged with input.
  // Thus v_draft_marker=NULL and v_copilot_draft remains its initial false value.
  let ordinary = discardFalseIf(writer, 'v_draft_marker IS NOT NULL');
  ordinary = ordinary.replace(/v_draft_marker\s+text\s*:=\s*nullif\(btrim\(coalesce\(p_row ->> 'copilot_draft_marker', ''\)\), ''\);/, '');
  ordinary = ordinary.replace(/v_copilot_draft\s+boolean\s*:=\s*false;/, '');
  for (let index = 0; index < 3; index++) ordinary = discardFalseIf(ordinary, 'v_copilot_draft');
  ordinary = ordinary.replace(/\bv_copilot_draft\b/g, 'false');
  // Both are absent from the fixed input. Removing absent keys is a no-op, not
  // a dependency on any Copilot object; other strings remain fully scanned.
  ordinary = ordinary.replace(", 'copilot_draft_marker', 'copilot_draft_only'", '');
  assert.doesNotMatch(ordinary, /copilot|v_draft_marker/i, 'ordinary receipt path has no Copilot dependency');
  assert.match(ordinary, /app_private\.ie_compat_actor_v2\(v_org\)/);
  assert.match(ordinary, /public\.cashbook_possession_bindings/);
  assert.match(ordinary, /INSERT INTO public\.income_expenses/);
  assert.match(ordinary, /INSERT INTO public\.income_expense_items/);
  return ordinary;
}
