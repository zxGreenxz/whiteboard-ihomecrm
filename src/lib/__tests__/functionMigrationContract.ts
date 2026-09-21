import { boChuThichSql } from "../../../scripts/lib/bo-chu-thich.mjs";

export type MigrationSource = { file: string; sql: string };
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compact = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/** Static contract for these named public RPCs, not a legacy migration replay.
 * CREATE OR REPLACE preserves privileges; DROP removes a signature. A final
 * catalog assertion can certify an unchanged ACL without repeating GRANT.
 */
export function functionMigrationContract(corpus: MigrationSource[], name: string) {
  const signatures = new Map<string, Set<string>>();
  const target = `public\\.${escape(name)}`;
  for (const { file, sql: source } of corpus) {
    const sql = boChuThichSql(source);
    const events: { at: number; apply: () => void }[] = [];
    const declarations = new RegExp(`(CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION|DROP\\s+FUNCTION(?:\\s+IF\\s+EXISTS)?)\\s+${target}\\s*\\(([^)]*)\\)`, "gi");
    for (const m of sql.matchAll(declarations)) {
      const creating = /^CREATE/i.test(m[1]);
      const types = m[2].split(",").filter(p => p.trim()).map(p => {
        const words = p.trim().split(/\s+/);
        return creating ? words[1] : words[0];
      });
      const signature = compact(`public.${name}(${types.join(",")})`);
      events.push({ at: m.index!, apply: () => {
        if (!creating) signatures.delete(signature);
        else if (!signatures.has(signature)) {
          // A new function needs explicit closure of PUBLIC/platform anon defaults.
          signatures.set(signature, new Set(["public", "anon"]));
        }
      } });
    }
    const permissions = new RegExp(`(GRANT\\s+(?:EXECUTE|ALL)|REVOKE\\s+(?:EXECUTE|ALL))\\s+ON\\s+FUNCTION\\s+${target}\\s*\\(([^)]*)\\)\\s+(?:TO|FROM)\\s+([^;]+);`, "gi");
    for (const m of sql.matchAll(permissions)) {
      const signature = compact(`public.${name}(${m[2]})`);
      events.push({ at: m.index!, apply: () => {
        const acl = signatures.get(signature);
        if (!acl) return;
        for (const role of m[3].split(",").map(r => r.trim().toLowerCase())) {
          if (/^GRANT/i.test(m[1])) acl.add(role); else acl.delete(role);
        }
      } });
    }
    // Require the executable catalog comparison, not just an expected ACL string.
    const guards = /FOR\s+f\s+IN\s+SELECT\s+\*\s+FROM\s+\(VALUES\s+([^;]+?)\)\s+expected\(signature,owner,acl\)\s+LOOP\s*([\s\S]*?)END\s+LOOP;/gi;
    for (const guard of sql.matchAll(guards)) {
      const row = new RegExp(`\\('${target}\\(([^']*)\\)','postgres','([^']*)'\\)`, "i").exec(guard[1]);
      if (!row) continue;
      const signature = compact(`public.${name}(${row[1]})`);
      events.push({ at: guard.index! + guard[0].length, apply: () => {
        const body = compact(guard[2]);
        if (!body.includes("selectproowner::regrole::textasowner,proacl::textasaclintopfrompg_procwhereoid=to_regprocedure(f.signature);") ||
            !/ifnotfoundorp\.ownerisdistinctfromf\.ownerorp\.aclisdistinctfromf\.aclthenraiseexception'[^']*',f\.signature;endif;/.test(body)) {
          throw new Error(`${file}: ${name} catalog ACL guard is not enforced`);
        }
        if (!signatures.has(signature)) throw new Error(`${file}: missing guarded signature ${signature}`);
        const acl = row[2].slice(1, -1).split(",").map(item => {
          const entry = /^([^=]*)=X\/postgres$/.exec(item);
          if (!entry) throw new Error(`${file}: unsupported/grantable ACL ${item}`);
          return entry[1].toLowerCase() || "public";
        });
        signatures.set(signature, new Set(acl));
      } });
    }
    events.sort((a, b) => a.at - b.at).forEach(event => event.apply());
  }
  return signatures;
}

export function assertPublicRpcContract(corpus: MigrationSource[], name: string, types: string) {
  const state = functionMigrationContract(corpus, name);
  const signature = compact(`public.${name}(${types})`);
  if (state.size !== 1 || !state.has(signature)) throw new Error(`${name}: unexpected overload/signature`);
  const acl = state.get(signature)!;
  if (acl.has("anon") || acl.has("public") || !acl.has("authenticated")) {
    throw new Error(`${name}: unsafe EXECUTE ACL`);
  }
}
