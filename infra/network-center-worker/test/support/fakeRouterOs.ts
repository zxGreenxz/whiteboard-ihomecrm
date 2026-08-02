/**
 * A deliberately small RouterOS console simulator.
 *
 * It exists so port-cycle tests exercise the *router's* contract rather than a
 * hand-written stub of the worker's own expectations:
 *
 *  - `:delay` suspends the running script. If the session dies inside it, every
 *    statement after the delay never runs (this is the whole point of Finding 1).
 *  - `/system/scheduler` entries live on the router, survive the SSH session and
 *    fire their stored `on-event` script after `interval` seconds.
 *  - `on-event` is stored as a RouterOS *string literal*, so it is unescaped with
 *    RouterOS escape rules. Unknown escapes (`\;`) and unescaped `$` are rejected
 *    exactly as the real console would, which keeps the generated script honest.
 */

export class RouterOsScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterOsScriptError";
  }
}

export class RouterOsSessionInterrupted extends Error {
  readonly partialOutput: string;

  constructor(partialOutput: string) {
    super("RouterOS session interrupted");
    this.name = "RouterOsSessionInterrupted";
    this.partialOutput = partialOutput;
  }
}

export interface FakeInterface {
  id: string;
  name: string;
  defaultName: string;
  type: string;
  disabled: boolean;
}

export interface FakeSchedulerEntry {
  name: string;
  comment: string;
  intervalSeconds: number;
  policy: string;
  onEvent: string;
  armedAtSeconds: number;
}

type Value =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "ids"; path: string; ids: string[] };

interface ExecutionState {
  variables: Map<string, Value>;
  output: string[];
  allowDelay: boolean;
  interruptAtDelay: boolean;
}

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
    if (quoted) {
      if (character === "\\") {
        current += character;
        escaped = true;
        continue;
      }
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
  if (quoted) throw new RouterOsScriptError("unterminated string literal");
  parts.push(current);
  return parts;
}

function statements(script: string): string[] {
  return splitTopLevel(script, ";\n").map((part) => part.trim()).filter(Boolean);
}

function tokens(text: string): string[] {
  return splitTopLevel(text, " \t").map((part) => part.trim()).filter(Boolean);
}

/** RouterOS string-literal semantics: only documented escapes, `$` interpolates. */
export function unquoteRouterOsString(token: string): string {
  if (!token.startsWith("\"")) return token;
  if (token.length < 2 || !token.endsWith("\"")) {
    throw new RouterOsScriptError("unterminated string literal");
  }
  const body = token.slice(1, -1);
  let output = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      if (character === "\"" || character === "\\" || character === "$" || character === "?") {
        output += character;
      } else if (character === "n") output += "\n";
      else if (character === "r") output += "\r";
      else if (character === "t") output += "\t";
      else throw new RouterOsScriptError(`invalid escape sequence \\${character}`);
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\"") throw new RouterOsScriptError("unescaped quote in string literal");
    if (character === "$") {
      throw new RouterOsScriptError("unescaped $ interpolates inside a RouterOS string literal");
    }
    output += character;
  }
  if (escaped) throw new RouterOsScriptError("dangling escape in string literal");
  return output;
}

function primitive(value: Value): string {
  switch (value.kind) {
    case "string":
      return value.value;
    case "number":
      return String(value.value);
    case "boolean":
      return value.value ? "true" : "false";
    case "ids":
      return value.ids.join(",");
  }
}

export class FakeRouterOs {
  readonly interfaces: FakeInterface[];
  readonly firewall: Array<Record<string, string>>;
  readonly scheduler: FakeSchedulerEntry[] = [];
  readonly trace: string[] = [];
  identity = "demo-router";
  clockSeconds = 0;

  constructor(options: {
    interfaces: FakeInterface[];
    firewall?: Array<Record<string, string>>;
    scheduler?: FakeSchedulerEntry[];
  }) {
    this.interfaces = options.interfaces.map((entry) => ({ ...entry }));
    this.firewall = (options.firewall ?? []).map((entry) => ({ ...entry }));
    for (const entry of options.scheduler ?? []) this.scheduler.push({ ...entry });
  }

  interfaceByDefaultName(defaultName: string): FakeInterface {
    const found = this.interfaces.find((entry) => entry.defaultName === defaultName);
    if (!found) throw new Error(`unknown fixture interface ${defaultName}`);
    return found;
  }

  printInterfaces(): string {
    return `${this.interfaces.map((entry) =>
      `.id=${entry.id} name=${entry.name} default-name=${entry.defaultName}`
      + ` type=${entry.type} disabled=${entry.disabled} running=${!entry.disabled}`,
    ).join("\n")}\n`;
  }

  printFirewall(): string {
    if (this.firewall.length === 0) return "";
    return `${this.firewall.map((record) =>
      Object.entries(record).map(([key, value]) => `${key}=${value}`).join(" "),
    ).join("\n")}\n`;
  }

  printIdentity(): string {
    return `name=${this.identity}\n`;
  }

  /** Runs a console script. Returns everything the script `:put` before it ended. */
  execute(script: string, options: { interruptAtDelay?: boolean } = {}): string {
    const state: ExecutionState = {
      variables: new Map(),
      output: [],
      allowDelay: true,
      interruptAtDelay: options.interruptAtDelay ?? false,
    };
    try {
      this.#runBlock(script, state);
    } catch (error) {
      if (error instanceof RouterOsSessionInterrupted) {
        throw new RouterOsSessionInterrupted(state.output.join(""));
      }
      throw error;
    }
    return state.output.join("");
  }

  /** Moves router time forward and fires every scheduler entry that became due. */
  advanceSeconds(seconds: number): void {
    this.clockSeconds += seconds;
    for (const entry of [...this.scheduler]) {
      if (!this.scheduler.includes(entry)) continue;
      if (this.clockSeconds - entry.armedAtSeconds < entry.intervalSeconds) continue;
      this.trace.push(`scheduler-fire:${entry.name}`);
      const state: ExecutionState = {
        variables: new Map(),
        output: [],
        allowDelay: false,
        interruptAtDelay: false,
      };
      this.#runBlock(entry.onEvent, state);
    }
  }

  #runBlock(script: string, state: ExecutionState): void {
    for (const statement of statements(script)) this.#runStatement(statement, state);
  }

  #runStatement(statement: string, state: ExecutionState): void {
    if (statement.startsWith(":local ")) {
      const parts = tokens(statement.slice(":local ".length));
      const name = parts[0];
      if (!name || parts.length < 2) throw new RouterOsScriptError("malformed :local");
      state.variables.set(name, this.#evaluate(parts.slice(1).join(" "), state));
      return;
    }
    if (statement.startsWith(":if ")) {
      this.#runConditional(statement, state);
      return;
    }
    if (statement.startsWith(":error")) {
      const value = this.#evaluate(statement.slice(":error".length).trim(), state);
      throw new RouterOsScriptError(primitive(value));
    }
    if (statement.startsWith(":put")) {
      const value = this.#evaluate(statement.slice(":put".length).trim(), state);
      state.output.push(`${primitive(value)}\n`);
      return;
    }
    if (statement.startsWith(":delay ")) {
      const raw = statement.slice(":delay ".length).trim();
      const match = /^(\d+)s$/.exec(raw);
      if (!match?.[1]) throw new RouterOsScriptError(`unsupported delay ${raw}`);
      if (!state.allowDelay) throw new RouterOsScriptError(":delay is not allowed here");
      this.trace.push(`delay:${match[1]}`);
      if (state.interruptAtDelay) throw new RouterOsSessionInterrupted(state.output.join(""));
      this.advanceSeconds(Number(match[1]));
      return;
    }
    for (const [prefix, enabled] of [
      ["/interface/disable ", false],
      ["/interface/enable ", true],
    ] as const) {
      if (!statement.startsWith(prefix)) continue;
      const target = this.#evaluate(statement.slice(prefix.length).trim(), state);
      if (target.kind !== "ids") throw new RouterOsScriptError("expected an interface selector");
      for (const id of target.ids) {
        const found = this.interfaces.find((entry) => entry.id === id);
        if (!found) throw new RouterOsScriptError("no such item");
        found.disabled = !enabled;
        this.trace.push(`${enabled ? "enable" : "disable"}:${found.defaultName}`);
      }
      return;
    }
    if (statement.startsWith("/system/scheduler add ")) {
      this.#addScheduler(statement.slice("/system/scheduler add ".length));
      return;
    }
    if (statement.startsWith("/system/scheduler remove ")) {
      const target = this.#evaluate(statement.slice("/system/scheduler remove ".length).trim(), state);
      if (target.kind !== "ids") throw new RouterOsScriptError("expected a scheduler selector");
      for (const name of target.ids) {
        const index = this.scheduler.findIndex((entry) => entry.name === name);
        if (index < 0) throw new RouterOsScriptError("no such item");
        this.scheduler.splice(index, 1);
        this.trace.push(`scheduler-remove:${name}`);
      }
      return;
    }
    throw new RouterOsScriptError(`bad command name (${statement.split(" ")[0] ?? ""})`);
  }

  #runConditional(statement: string, state: ExecutionState): void {
    const rest = statement.slice(":if ".length).trim();
    const [condition, afterCondition] = this.#readGroup(rest, "(", ")");
    const branches = new Map<string, string>();
    let cursor = afterCondition.trim();
    while (cursor.startsWith("do=") || cursor.startsWith("else=")) {
      const keyword = cursor.startsWith("do=") ? "do" : "else";
      const [block, remainder] = this.#readGroup(
        cursor.slice(`${keyword}=`.length).trim(),
        "{",
        "}",
      );
      branches.set(keyword, block);
      cursor = remainder.trim();
    }
    if (cursor.length > 0) throw new RouterOsScriptError(`expected end of command (${cursor})`);
    const chosen = this.#condition(condition, state) ? branches.get("do") : branches.get("else");
    if (chosen !== undefined) this.#runBlock(chosen, state);
  }

  #readGroup(text: string, open: string, close: string): [string, string] {
    if (!text.startsWith(open)) throw new RouterOsScriptError(`expected ${open}`);
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index] ?? "";
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted) {
        if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
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
    throw new RouterOsScriptError(`unbalanced ${open}${close}`);
  }

  #condition(text: string, state: ExecutionState): boolean {
    const parts = tokens(text);
    const operatorIndex = parts.findIndex((part) => ["=", "!=", ">", "<"].includes(part));
    if (operatorIndex < 1) throw new RouterOsScriptError(`unsupported condition (${text})`);
    const left = this.#evaluate(parts.slice(0, operatorIndex).join(" "), state);
    const right = this.#evaluate(parts.slice(operatorIndex + 1).join(" "), state);
    const operator = parts[operatorIndex];
    if (operator === "=") return primitive(left) === primitive(right);
    if (operator === "!=") return primitive(left) !== primitive(right);
    const leftNumber = Number(primitive(left));
    const rightNumber = Number(primitive(right));
    return operator === ">" ? leftNumber > rightNumber : leftNumber < rightNumber;
  }

  #addScheduler(argumentText: string): void {
    const values = new Map<string, string>();
    for (const token of tokens(argumentText)) {
      const separator = token.indexOf("=");
      if (separator <= 0) throw new RouterOsScriptError(`expected end of command (${token})`);
      values.set(token.slice(0, separator), unquoteRouterOsString(token.slice(separator + 1)));
    }
    const name = values.get("name");
    const comment = values.get("comment");
    const onEvent = values.get("on-event");
    const interval = values.get("interval");
    const policy = values.get("policy") ?? "";
    if (!name || comment === undefined || !onEvent || !interval) {
      throw new RouterOsScriptError("scheduler add requires name, comment, interval and on-event");
    }
    const match = /^(\d+)s$/.exec(interval);
    if (!match?.[1]) throw new RouterOsScriptError(`unsupported interval ${interval}`);
    // The managed router user owns ssh,ftp,reboot,read,write,test,sensitive.
    const granted = new Set(["ssh", "ftp", "reboot", "read", "write", "test", "sensitive"]);
    for (const requested of policy.split(",").filter(Boolean)) {
      if (!granted.has(requested)) {
        throw new RouterOsScriptError(`failure: not enough permissions (${requested})`);
      }
    }
    if (this.scheduler.some((entry) => entry.name === name)) {
      throw new RouterOsScriptError("failure: already have entry with the same name");
    }
    // A stored on-event must itself be a script the console can run later.
    statements(onEvent);
    this.scheduler.push({
      name,
      comment,
      intervalSeconds: Number(match[1]),
      policy,
      onEvent,
      armedAtSeconds: this.clockSeconds,
    });
    this.trace.push(`scheduler-add:${name}:${match[1]}s`);
  }

  #evaluate(text: string, state: ExecutionState): Value {
    const trimmed = text.trim();
    if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
      const parts = splitTopLevel(trimmed.slice(1, -1), ".");
      if (parts.length > 1) {
        return {
          kind: "string",
          value: parts.map((part) => primitive(this.#evaluate(part, state))).join(""),
        };
      }
      return this.#evaluate(trimmed.slice(1, -1), state);
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return this.#evaluateCommand(trimmed.slice(1, -1).trim(), state);
    }
    if (trimmed.startsWith("$")) {
      const value = state.variables.get(trimmed.slice(1));
      if (!value) throw new RouterOsScriptError(`undefined variable ${trimmed}`);
      return value;
    }
    if (trimmed.startsWith("\"")) return { kind: "string", value: unquoteRouterOsString(trimmed) };
    if (/^-?\d+$/.test(trimmed)) return { kind: "number", value: Number(trimmed) };
    if (trimmed === "true" || trimmed === "false") {
      return { kind: "boolean", value: trimmed === "true" };
    }
    return { kind: "string", value: trimmed };
  }

  #evaluateCommand(text: string, state: ExecutionState): Value {
    const parts = tokens(text);
    const head = parts[0] ?? "";
    if (head === ":len") {
      const value = this.#evaluate(parts.slice(1).join(" "), state);
      return {
        kind: "number",
        value: value.kind === "ids" ? value.ids.length : primitive(value).length,
      };
    }
    if (head === "/interface/find") {
      return {
        kind: "ids",
        path: "/interface",
        ids: this.#findInterfaces(parts.slice(1), state).map((entry) => entry.id),
      };
    }
    if (head === "/system/scheduler") {
      const verb = parts[1] ?? "";
      if (verb === "find") {
        return {
          kind: "ids",
          path: "/system/scheduler",
          ids: this.#findScheduler(parts.slice(2), state).map((entry) => entry.name),
        };
      }
      if (verb === "get") {
        const target = this.#evaluate(parts[2] ?? "", state);
        if (target.kind !== "ids" || target.ids.length !== 1) {
          throw new RouterOsScriptError("no such item");
        }
        const entry = this.scheduler.find((candidate) => candidate.name === target.ids[0]);
        if (!entry) throw new RouterOsScriptError("no such item");
        const field = parts[3] ?? "";
        if (field === "comment") return { kind: "string", value: entry.comment };
        if (field === "name") return { kind: "string", value: entry.name };
        if (field === "on-event") return { kind: "string", value: entry.onEvent };
        throw new RouterOsScriptError(`unsupported scheduler field ${field}`);
      }
      throw new RouterOsScriptError(`bad command name (/system/scheduler ${verb})`);
    }
    if (head === "/interface/get") {
      const target = this.#evaluate(parts[1] ?? "", state);
      if (target.kind !== "ids" || target.ids.length !== 1) {
        throw new RouterOsScriptError("no such item");
      }
      const entry = this.interfaces.find((candidate) => candidate.id === target.ids[0]);
      if (!entry) throw new RouterOsScriptError("no such item");
      const field = parts[2] ?? "";
      if (field === "disabled") return { kind: "boolean", value: entry.disabled };
      if (field === "default-name") return { kind: "string", value: entry.defaultName };
      if (field === "name") return { kind: "string", value: entry.name };
      throw new RouterOsScriptError(`unsupported interface field ${field}`);
    }
    throw new RouterOsScriptError(`bad command name (${head})`);
  }

  #criteria(parts: string[], state: ExecutionState): Array<[string, string]> {
    if ((parts[0] ?? "") !== "where") throw new RouterOsScriptError("expected where");
    const criteria: Array<[string, string]> = [];
    for (const token of parts.slice(1)) {
      if (token === "and") continue;
      const separator = token.indexOf("=");
      if (separator <= 0) throw new RouterOsScriptError(`unsupported criterion ${token}`);
      criteria.push([
        token.slice(0, separator),
        primitive(this.#evaluate(token.slice(separator + 1), state)),
      ]);
    }
    return criteria;
  }

  #findInterfaces(parts: string[], state: ExecutionState): FakeInterface[] {
    const criteria = this.#criteria(parts, state);
    return this.interfaces.filter((entry) => criteria.every(([key, value]) => {
      if (key === ".id") return entry.id === value;
      if (key === "name") return entry.name === value;
      if (key === "default-name") return entry.defaultName === value;
      if (key === "type") return entry.type === value;
      if (key === "disabled") return String(entry.disabled) === value;
      throw new RouterOsScriptError(`unsupported interface criterion ${key}`);
    }));
  }

  #findScheduler(parts: string[], state: ExecutionState): FakeSchedulerEntry[] {
    const criteria = this.#criteria(parts, state);
    return this.scheduler.filter((entry) => criteria.every(([key, value]) => {
      if (key === "name") return entry.name === value;
      if (key === "comment") return entry.comment === value;
      throw new RouterOsScriptError(`unsupported scheduler criterion ${key}`);
    }));
  }
}
