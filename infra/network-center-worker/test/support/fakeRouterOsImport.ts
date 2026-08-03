/**
 * A RouterOS `/import` simulator for the generated `.rsc` assets.
 *
 * ## Why this exists
 *
 * `router-bootstrap.rsc`, `router-lockdown.rsc` and `router-rollback.rsc` had only
 * ever been asserted as TEXT. Text assertions cannot see what a `find where`
 * selector *matches at runtime*, and that is precisely where the worst defect on
 * this branch lived: `/ip/service set [find where name="ssh"]` also matches the
 * DYNAMIC connection entry RouterOS lists beside the static service, so the
 * selector resolves to two rows whenever an SSH session is live — which is always,
 * because the scripts are delivered over SSH.
 *
 * Everything this file models about that contract is pinned to a measurement taken
 * on the demo hEX (RouterOS 7.20.8), not to guesswork:
 *
 *  - a no-op `/ip/service set [find where name="ssh"] port=22` (already 22) with a
 *    live SSH session reported `count=2` and `SET_NOOP_RESULT=ERROR`, and left the
 *    values unchanged. The mechanism is that a dynamic row is not settable, so the
 *    whole command is refused;
 *  - `/import` runs top to bottom and stops at the first failing statement. It does
 *    NOT roll back what already succeeded, which is the difference between "the
 *    rollback script is inert" and "the bootstrap left the gateway half-configured".
 *
 * ## What it deliberately does not model
 *
 * Routing, packet forwarding, RouterOS type coercion beyond boolean leniency, and
 * every menu the generated scripts never touch. It is a selector-and-mutation
 * model, not a router. Where a construct is not supported it throws rather than
 * guessing, so an unsupported construct can never be mistaken for a passing test.
 *
 * ## The gap this file used to have
 *
 * It had no PARSER, so 22 RouterOS syntax errors ran through it cleanly and were
 * first seen by `/import ... dry-run` on the hardware. `importRouterOsScript`
 * now runs `routerOsScriptDiagnostics` first, so nothing this simulator accepts
 * can be a file the router would reject. The interpreter below is deliberately
 * kept in step with those rules: it evaluates `!(x ~ "…")`, which the hardware
 * accepts, and has no `!~`, which the hardware does not. Statement splitting is
 * the generator's own `routerOsStatements`, so the text the enforcement checks
 * read and the text this interpreter executes cannot drift apart.
 *
 * ## `verbose=yes`, measured on the demo hEX (RouterOS 7.20.8, 2026-08-03)
 *
 * See `RouterOsImportOptions.verbose`.
 */
import {
  routerOsScriptDiagnostics,
  routerOsStatements as splitRouterOsStatements,
} from "../../scripts/generate-router-bootstrap.mjs";

export class RouterOsSyntaxError extends Error {
  readonly diagnostics: ReturnType<typeof routerOsScriptDiagnostics>;

  constructor(diagnostics: ReturnType<typeof routerOsScriptDiagnostics>) {
    super(
      `RouterOS would refuse this script: ${diagnostics.length} diagnostic(s), first `
      + `${diagnostics[0]?.rule ?? "?"} at line ${diagnostics[0]?.line ?? 0}`,
    );
    this.name = "RouterOsSyntaxError";
    this.diagnostics = diagnostics;
  }
}

export class RouterOsImportError extends Error {
  /** 1-based line of the statement that failed, as `/import` reports it. */
  readonly line: number;

  readonly statement: string;

  /**
   * Everything the script `:put` before it died. `/import` prints it, and with
   * `verbose=no` in the runbook it is the only progress trace an operator has.
   */
  output: string[] = [];

  constructor(message: string, line: number, statement: string) {
    super(message);
    this.name = "RouterOsImportError";
    this.line = line;
    this.statement = statement;
  }
}

export type RouterOsRow = Record<string, string>;

export interface RouterOsMenuDefinition {
  rows?: RouterOsRow[];
  /** `/ip/ssh` and friends: exactly one implicit row, never addressed by a selector. */
  settings?: RouterOsRow;
}

export interface RouterOsStatement {
  text: string;
  line: number;
}

type Value =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "ids"; path: string; ids: string[] };

const TRUE_WORDS = new Set(["yes", "true"]);
const FALSE_WORDS = new Set(["no", "false"]);

function booleanEquals(left: string, right: string): boolean {
  if (TRUE_WORDS.has(left) && TRUE_WORDS.has(right)) return true;
  if (FALSE_WORDS.has(left) && FALSE_WORDS.has(right)) return true;
  return false;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && TRUE_WORDS.has(value);
}

/**
 * Splits on `separators` that sit outside quotes, brackets, braces and parens, so a
 * `:if (...)` may span lines and a `do={...}` block may contain `;`.
 */
function splitTopLevel(text: string, separators: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (const character of text) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quoted) {
      if (character === "\"") quoted = false;
      current += character;
      continue;
    }
    if (character === "\"") {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") depth += 1;
    if (character === "]" || character === "}" || character === ")") depth -= 1;
    if (depth === 0 && separators.includes(character)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Same rules as `splitTopLevel`, but for a two-character operator such as `&&`. */
function splitTopLevelOperator(text: string, operator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quoted) {
      if (character === "\"") quoted = false;
      current += character;
      continue;
    }
    if (character === "\"") {
      quoted = true;
      current += character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") depth += 1;
    if (character === "]" || character === "}" || character === ")") depth -= 1;
    if (depth === 0 && text.startsWith(operator, index)) {
      parts.push(current);
      current = "";
      index += operator.length - 1;
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function tokens(text: string): string[] {
  return splitTopLevel(text, " \t\n").map((part) => part.trim()).filter(Boolean);
}

/**
 * Statements with the 1-based source line `/import` would name in an error.
 * Comment lines are dropped; a statement may span lines inside `(`, `[` or `{`.
 *
 * This is the generator's splitter, not a second one: the diagnosability rules
 * the generator enforces ("every mutation has its own breadcrumb") are only
 * meaningful if the statements it counts are the statements `/import` runs, and
 * two independent implementations of that would eventually disagree.
 */
export function routerOsStatements(script: string): RouterOsStatement[] {
  return splitRouterOsStatements(script);
}

/**
 * RouterOS string-literal semantics, limited to the escapes `routerOsQuote` emits.
 * `\;` is accepted as a literal `;` because the generator escapes semicolons.
 */
function unquote(token: string): string {
  if (!token.startsWith("\"")) return token;
  if (token.length < 2 || !token.endsWith("\"")) throw new Error("unterminated string literal");
  const body = token.slice(1, -1);
  let output = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      if (!["\"", "\\", "$", ";", "?"].includes(character)) {
        throw new Error(`invalid escape sequence \\${character}`);
      }
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    output += character;
  }
  if (escaped) throw new Error("dangling escape in string literal");
  return output;
}

export class FakeRouterOsDevice {
  readonly #menus = new Map<string, RouterOsRow[]>();

  readonly #settings = new Map<string, RouterOsRow>();

  /** One entry per applied mutation, in order. Empty means nothing was changed. */
  readonly mutations: string[] = [];

  #nextId = 0;

  constructor(definitions: Record<string, RouterOsMenuDefinition>) {
    for (const [path, definition] of Object.entries(definitions)) {
      if (definition.settings) {
        this.#settings.set(path, { ...definition.settings });
        continue;
      }
      this.#menus.set(
        path,
        (definition.rows ?? []).map((row) => ({ ".id": this.mintId(), ...row })),
      );
    }
  }

  mintId(): string {
    this.#nextId += 1;
    return `*${this.#nextId.toString(16).toUpperCase()}`;
  }

  /** Throws for an unmodelled menu so a typo cannot silently match nothing. */
  rows(path: string): RouterOsRow[] {
    const rows = this.#menus.get(path);
    if (!rows) throw new Error(`no such command prefix (${path})`);
    return rows;
  }

  settings(path: string): RouterOsRow {
    const row = this.#settings.get(path);
    if (!row) throw new Error(`no such command prefix (${path})`);
    return row;
  }

  has(path: string): boolean {
    return this.#menus.has(path) || this.#settings.has(path);
  }

  isSettings(path: string): boolean {
    return this.#settings.has(path);
  }
}

class Interpreter {
  readonly #device: FakeRouterOsDevice;

  readonly #variables = new Map<string, Value>();

  /** `/import … verbose=yes`. See `RouterOsImportOptions.verbose`. */
  readonly #verbose: boolean;

  /** Depth of `:if` / `:while` CONDITION evaluation. Bodies are at depth 0. */
  #conditionDepth = 0;

  readonly output: string[] = [];

  #statement: RouterOsStatement = { text: "", line: 0 };

  constructor(device: FakeRouterOsDevice, verbose = false) {
    this.#device = device;
    this.#verbose = verbose;
  }

  run(script: string): void {
    for (const statement of routerOsStatements(script)) {
      this.#statement = statement;
      this.#runStatement(statement.text);
    }
  }

  #fail(message: string): never {
    throw new RouterOsImportError(message, this.#statement.line, this.#statement.text);
  }

  #runStatement(statement: string): void {
    if (statement.startsWith(":local ")) {
      const rest = statement.slice(":local ".length).trim();
      const separator = rest.search(/\s/u);
      if (separator < 0) this.#fail("malformed :local");
      this.#variables.set(rest.slice(0, separator), this.#evaluate(rest.slice(separator + 1)));
      return;
    }
    if (statement.startsWith(":if ")) {
      this.#runConditional(statement.slice(":if ".length).trim());
      return;
    }
    if (statement.startsWith(":error")) {
      this.#fail(this.#text(this.#evaluate(statement.slice(":error".length).trim())));
    }
    if (statement.startsWith(":put ")) {
      this.output.push(this.#text(this.#evaluate(statement.slice(":put ".length).trim())));
      return;
    }
    if (statement.startsWith("/")) {
      this.#runCommand(statement);
      return;
    }
    this.#fail(`bad command name (${statement.split(/\s/u)[0] ?? ""})`);
  }

  #runConditional(text: string): void {
    const [condition, afterCondition] = this.#readGroup(text, "(", ")");
    let cursor = afterCondition.trim();
    const branches = new Map<string, string>();
    while (cursor.startsWith("do=") || cursor.startsWith("else=")) {
      const keyword = cursor.startsWith("do=") ? "do" : "else";
      const [block, remainder] = this.#readGroup(cursor.slice(`${keyword}=`.length).trim(), "{", "}");
      branches.set(keyword, block);
      cursor = remainder.trim();
    }
    if (cursor.length > 0) this.#fail(`expected end of command (${cursor})`);
    this.#conditionDepth += 1;
    let taken: boolean;
    try {
      taken = this.#condition(condition);
    } finally {
      this.#conditionDepth -= 1;
    }
    const chosen = taken ? branches.get("do") : branches.get("else");
    if (chosen === undefined) return;
    for (const inner of routerOsStatements(chosen)) this.#runStatement(inner.text);
  }

  #readGroup(text: string, open: string, close: string): [string, string] {
    if (!text.startsWith(open)) this.#fail(`expected ${open}`);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quoted) {
        if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") {
        quoted = true;
        continue;
      }
      if (character === open) depth += 1;
      else if (character === close) {
        depth -= 1;
        if (depth === 0) return [text.slice(1, index), text.slice(index + 1)];
      }
    }
    return this.#fail(`unbalanced ${open}${close}`);
  }

  /** `||` and `&&` short-circuit, exactly as the generated preflight relies on. */
  #condition(text: string): boolean {
    const trimmed = text.trim();
    const alternatives = splitTopLevelOperator(trimmed, "||");
    if (alternatives.length > 1) {
      return alternatives.some((part) => this.#condition(part));
    }
    const conjuncts = splitTopLevelOperator(trimmed, "&&");
    if (conjuncts.length > 1) {
      return conjuncts.every((part) => this.#condition(part));
    }
    if (trimmed.startsWith("(") && this.#readGroup(trimmed, "(", ")")[1].trim() === "") {
      return this.#condition(this.#readGroup(trimmed, "(", ")")[0]);
    }
    // `!(x ~ "…")` — the measured working negation. `!~` is deliberately absent
    // from the operator table below: RouterOS parses it as "invert a string" and
    // dies with `Script Error: cannot invert string`.
    if (trimmed.startsWith("!")) {
      const rest = trimmed.slice(1).trim();
      if (rest.startsWith("(")) {
        const [inner, remainder] = this.#readGroup(rest, "(", ")");
        if (remainder.trim() === "") return !this.#condition(inner);
      }
    }
    for (const operator of ["!=", "~", ">=", "<=", "=", ">", "<"]) {
      const parts = splitTopLevelOperator(trimmed, operator);
      if (parts.length !== 2) continue;
      const leftText = (parts[0] ?? "").trim();
      const rightText = (parts[1] ?? "").trim();
      if (!leftText || !rightText) continue;
      // `!=` must not be read as `=`; the loop order guarantees the longer
      // operators are tried first, but a trailing `!` would still slip through.
      if (leftText.endsWith("!") || leftText.endsWith("<") || leftText.endsWith(">")) continue;
      const left = this.#evaluate(leftText);
      const right = this.#evaluate(rightText);
      if (operator === "~") {
        return new RegExp(this.#text(right), "u").test(this.#text(left));
      }
      if (operator === "=") return this.#text(left) === this.#text(right);
      if (operator === "!=") return this.#text(left) !== this.#text(right);
      const leftNumber = Number(this.#text(left));
      const rightNumber = Number(this.#text(right));
      if (operator === ">") return leftNumber > rightNumber;
      if (operator === "<") return leftNumber < rightNumber;
      if (operator === ">=") return leftNumber >= rightNumber;
      return leftNumber <= rightNumber;
    }
    return this.#fail(`unsupported condition (${trimmed})`);
  }

  #text(value: Value): string {
    if (value.kind === "text") return value.value;
    if (value.kind === "number") return String(value.value);
    return value.ids.join(";");
  }

  #evaluate(text: string): Value {
    const trimmed = text.trim();
    if (trimmed.startsWith("(")) {
      const [inner, remainder] = this.#readGroup(trimmed, "(", ")");
      if (remainder.trim() !== "") this.#fail(`expected end of expression (${remainder})`);
      const pieces = splitTopLevel(inner, ".");
      if (pieces.length > 1) {
        return {
          kind: "text",
          value: pieces.map((piece) => this.#text(this.#evaluate(piece))).join(""),
        };
      }
      return this.#evaluate(inner);
    }
    if (trimmed.startsWith("[")) {
      const [inner, remainder] = this.#readGroup(trimmed, "[", "]");
      if (remainder.trim() !== "") this.#fail(`expected end of expression (${remainder})`);
      return this.#evaluateCommand(inner.trim());
    }
    if (trimmed.startsWith("$")) {
      const value = this.#variables.get(trimmed.slice(1));
      if (!value) this.#fail(`undefined variable ${trimmed}`);
      // MEASURED, not theorised: under `verbose=yes` a `:local` reads as EMPTY
      // inside an `:if` CONDITION while the same variable prints correctly with
      // `:put`. Only that difference is modelled — see the class comment on
      // `RouterOsImportOptions.verbose` for exactly what was and was not
      // measured, and why no mechanism is assumed.
      if (this.#verbose && this.#conditionDepth > 0) return { kind: "text", value: "" };
      return value;
    }
    if (trimmed.startsWith("\"")) {
      try {
        return { kind: "text", value: unquote(trimmed) };
      } catch (error) {
        return this.#fail((error as Error).message);
      }
    }
    if (/^-?\d+$/u.test(trimmed)) return { kind: "number", value: Number(trimmed) };
    return { kind: "text", value: trimmed };
  }

  #evaluateCommand(text: string, menuContext?: string): Value {
    const parts = tokens(text);
    const head = parts[0] ?? "";
    if (head === ":len") {
      const value = this.#evaluate(parts.slice(1).join(" "));
      return {
        kind: "number",
        value: value.kind === "ids" ? value.ids.length : this.#text(value).length,
      };
    }
    if (head === ":tostr") {
      return { kind: "text", value: this.#text(this.#evaluate(parts.slice(1).join(" "))) };
    }
    // `[find where ...]` inside a command is resolved against that command's menu.
    if (head === "find") {
      if (!menuContext) this.#fail("menu-relative find outside a command");
      return this.#find(menuContext, parts.slice(1));
    }
    const [path, verb] = this.#splitPathVerb(head, parts[1] ?? "");
    if (verb === "find") {
      const skip = head.endsWith("/find") ? 1 : 2;
      return this.#find(path, parts.slice(skip));
    }
    if (verb === "get") {
      const skip = head.endsWith("/get") ? 1 : 2;
      return this.#get(path, parts.slice(skip));
    }
    return this.#fail(`bad command name (${head})`);
  }

  /** Handles both `/ip/address/find` and `/ip/address find`. */
  #splitPathVerb(head: string, next: string): [string, string] {
    for (const verb of ["find", "get", "add", "set", "remove", "import"]) {
      if (head.endsWith(`/${verb}`)) return [head.slice(0, -(verb.length + 1)), verb];
    }
    return [head, next];
  }

  #find(path: string, terms: string[]): Value {
    if ((terms[0] ?? "") !== "where") this.#fail(`expected where (${path})`);
    if (!this.#device.has(path)) this.#fail(`no such command prefix (${path})`);
    const predicates = this.#predicates(terms.slice(1));
    const ids = this.#device.rows(path)
      .filter((row) => predicates.every((predicate) => predicate(row)))
      .map((row) => row[".id"] ?? "");
    return { kind: "ids", path, ids };
  }

  #predicates(terms: string[]): Array<(row: RouterOsRow) => boolean> {
    const predicates: Array<(row: RouterOsRow) => boolean> = [];
    for (const term of terms) {
      if (term === "and") continue;
      if (term.startsWith("!")) {
        const key = term.slice(1);
        predicates.push((row) => !isTruthy(row[key]));
        continue;
      }
      const separator = term.indexOf("=");
      if (separator <= 0) this.#fail(`unsupported criterion ${term}`);
      const key = term.slice(0, separator);
      const expected = this.#text(this.#evaluate(term.slice(separator + 1)));
      predicates.push((row) => {
        const actual = row[key] ?? "";
        return actual === expected || booleanEquals(actual, expected);
      });
    }
    return predicates;
  }

  #get(path: string, parts: string[]): Value {
    const target = this.#evaluate(parts[0] ?? "");
    if (target.kind !== "ids" || target.ids.length !== 1) this.#fail("no such item");
    const id = target.kind === "ids" ? target.ids[0] : "";
    const row = this.#device.rows(path).find((candidate) => candidate[".id"] === id);
    if (!row) this.#fail("no such item");
    const field = parts[1] ?? "";
    const value = row[field];
    // A property a row does not carry is a hard error on real RouterOS. A bridge
    // has no `default-name`, which is exactly the trap a type-blind preflight hits.
    if (value === undefined) this.#fail(`unknown item property (${field})`);
    return { kind: "text", value };
  }

  #runCommand(statement: string): void {
    const parts = tokens(statement);
    const [path, verb] = this.#splitPathVerb(parts[0] ?? "", parts[1] ?? "");
    const skip = (parts[0] ?? "").endsWith(`/${verb}`) ? 1 : 2;
    const rest = parts.slice(skip);
    if (!this.#device.has(path)) this.#fail(`no such command prefix (${path})`);
    if (verb === "add" || (verb === "import" && rest.every((token) => token.includes("=")))) {
      this.#device.rows(path).push({ ".id": this.#device.mintId(), ...this.#assignments(rest, path) });
      this.#device.mutations.push(`${verb} ${path}`);
      return;
    }
    if (verb === "set") {
      if (this.#device.isSettings(path)) {
        Object.assign(this.#device.settings(path), this.#assignments(rest));
        this.#device.mutations.push(`set ${path}`);
        return;
      }
      const selected = this.#select(path, rest[0] ?? "");
      const assignments = this.#assignments(rest.slice(1), path);
      // The measured hardware contract: a selector that also matches a dynamic row
      // makes the whole `set` fail, and nothing is written.
      this.#refuseDynamic(path, selected, "set");
      for (const row of selected) Object.assign(row, assignments);
      this.#device.mutations.push(`set ${path} x${selected.length}`);
      return;
    }
    if (verb === "remove") {
      const selected = this.#select(path, rest.join(" "));
      this.#refuseDynamic(path, selected, "remove");
      const rows = this.#device.rows(path);
      for (const row of selected) rows.splice(rows.indexOf(row), 1);
      this.#device.mutations.push(`remove ${path} x${selected.length}`);
      return;
    }
    this.#fail(`bad command name (${path} ${verb})`);
  }

  #refuseDynamic(path: string, selected: RouterOsRow[], verb: string): void {
    if (selected.some((row) => isTruthy(row.dynamic))) {
      this.#fail(`failure: cannot ${verb} a dynamic item (${path}); matched ${selected.length}`);
    }
  }

  #select(path: string, selectorText: string): RouterOsRow[] {
    const trimmed = selectorText.trim();
    const value = trimmed.startsWith("[")
      ? this.#evaluateCommand(this.#readGroup(trimmed, "[", "]")[0].trim(), path)
      : this.#evaluate(trimmed);
    if (value.kind !== "ids") this.#fail(`expected a selector (${path})`);
    if (value.path !== path) this.#fail(`selector menu ${value.path} used on ${path}`);
    return value.ids.flatMap((id) => {
      const row = this.#device.rows(path).find((candidate) => candidate[".id"] === id);
      return row ? [row] : [];
    });
  }

  #assignments(parts: string[], path?: string): RouterOsRow {
    const values: RouterOsRow = {};
    for (const token of parts) {
      const separator = token.indexOf("=");
      if (separator <= 0) this.#fail(`expected end of command (${token})`);
      values[token.slice(0, separator)] = this.#text(this.#evaluate(token.slice(separator + 1)));
    }
    // RouterOS does not store a group's `policy` as the text it was handed: it
    // parses it into an array and renders it back `;`-joined with every denied
    // policy spelled out as `!name`. Echoing the written form back is what let a
    // preflight that can NEVER match on hardware pass every test in this suite.
    if (path === "/user/group" && typeof values.policy === "string") {
      values.policy = normalizeGroupPolicy(values.policy);
    }
    return values;
  }
}

/**
 * Every policy RouterOS 7.20.8 knows, in the canonical order it renders them —
 * read off the demo hEX's own built-in `full` group on 2026-08-03.
 */
export const ROUTER_OS_POLICIES = [
  "local", "telnet", "ssh", "ftp", "reboot", "read", "write", "policy", "test",
  "winbox", "password", "web", "sniff", "sensitive", "api", "romon", "rest-api",
] as const;

/**
 * A group's `policy` AS ROUTEROS RENDERS IT. MEASURED verbatim on the demo hEX
 * (RouterOS 7.20.8, 2026-08-03) for the three groups that router carries:
 *
 *   read   local;telnet;ssh;reboot;read;test;winbox;password;web;sniff;
 *          sensitive;api;romon;rest-api;!ftp;!write;!policy
 *   full   local;telnet;ssh;ftp;reboot;read;write;policy;test;winbox;password;
 *          web;sniff;sensitive;api;romon;rest-api
 *   network-center-worker
 *          ssh;ftp;reboot;read;write;test;sensitive;!local;!telnet;!policy;
 *          !winbox;!password;!web;!sniff;!api;!romon;!rest-api
 */
export function groupPolicyValue(granted: readonly string[]): string {
  const grantedSet = new Set(granted);
  const unknown = granted.filter((name) => !ROUTER_OS_POLICIES.includes(name as never));
  if (unknown.length > 0) throw new Error(`unknown RouterOS policy: ${unknown.join(",")}`);
  return [
    ...ROUTER_OS_POLICIES.filter((name) => grantedSet.has(name)),
    ...ROUTER_OS_POLICIES.filter((name) => !grantedSet.has(name)).map((name) => `!${name}`),
  ].join(";");
}

/** `policy=ssh,ftp,…` as written in a script -> what the router reports back. */
export function normalizeGroupPolicy(written: string): string {
  return groupPolicyValue(
    written.split(/[,;]/u).map((name) => name.trim()).filter((name) => name && !name.startsWith("!")),
  );
}

export interface RouterOsImportResult {
  output: string[];
  /** Mutations applied before the script ended, in order. */
  mutations: string[];
}

export interface RouterOsImportOptions {
  /**
   * `/import … verbose=yes`.
   *
   * ## What was measured (demo hEX, RouterOS 7.20.8, 2026-08-03)
   *
   * Same file, same router, same config; the flag is the only difference:
   *
   * ```
   * :local a [/interface find where name="bridge"]
   * :local b [/interface find where name="ether1"]
   * :put ("LEN_A=" . [:len $a] . " LEN_B=" . [:len $b])
   * :if ([:len $a] != 1 || [:len $b] != 1) do={ :put "FIRED_UNEXPECTEDLY" }
   * :if ([:len $a] != 1) do={ :put "FIRED_SINGLELINE" }
   * ```
   *
   * | flag          | output                                                    |
   * |---------------|-----------------------------------------------------------|
   * | `verbose=no`  | `LEN_A=1 LEN_B=1` … `END` — neither `:if` fires (correct) |
   * | `verbose=yes` | `LEN_A=1 LEN_B=1` … `FIRED_UNEXPECTEDLY` `FIRED_SINGLELINE` |
   *
   * And on the real `router-bootstrap.rsc`, with the same state and the same
   * bytes: `verbose=no` runs the whole preflight through, `verbose=yes` stops at
   * `NETWORK_CENTER_RECOVERY_INTERFACE_INVALID/…` — a condition that is false on
   * that hardware (`R_LEN=1 W_LEN=1 R_VAL=*7 W_VAL=*2`).
   *
   * ## What the model therefore says, and only that
   *
   * A variable read inside an `:if` CONDITION yields the empty value. Nothing
   * else changes: `:put` still prints the variable, `:local` still persists, a
   * one-element `find` is still `typeof=array len=1`.
   *
   * ## What is deliberately NOT modelled
   *
   * *Why* RouterOS does this — unknown, and a mechanism guessed here would put
   * behaviour in the simulator that nothing observed. Variable reads inside a
   * `do={ … }` BODY were never measured either, so they are left alone; the
   * consequence that matters (a guard evaluating against empty variables) is
   * already fully expressed by the condition rule.
   */
  verbose?: boolean;
}

/**
 * Runs a generated `.rsc` the way `/import` does: it PARSES first and refuses
 * the whole file if RouterOS would, then executes statement by statement,
 * stopping at the first failure and keeping everything already written.
 */
export function importRouterOsScript(
  device: FakeRouterOsDevice,
  script: string,
  options: RouterOsImportOptions = {},
): RouterOsImportResult {
  const diagnostics = routerOsScriptDiagnostics(script);
  if (diagnostics.length > 0) throw new RouterOsSyntaxError(diagnostics);
  const interpreter = new Interpreter(device, options.verbose ?? false);
  try {
    interpreter.run(script);
  } catch (error) {
    // A failed `/import` still leaves everything the script printed on the
    // console. Losing it here would hide the breadcrumb trail in exactly the
    // case it exists for.
    if (error instanceof RouterOsImportError) error.output = [...interpreter.output];
    throw error;
  }
  return { output: interpreter.output, mutations: [...device.mutations] };
}
