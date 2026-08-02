/**
 * A deliberately small RouterOS console simulator.
 *
 * It exists so port-cycle tests exercise the *router's* contract rather than a
 * hand-written stub of the worker's own expectations:
 *
 *  - `:delay` suspends the running script. If the session dies inside it, every
 *    statement after the delay never runs (this is the whole point of Finding 1).
 *  - `:execute` starts a *background job*. The job outlives the console job that
 *    started it, keeps its own cursor into the stored script text, and its
 *    `:delay` really consumes router time — `advanceSeconds` resumes it from
 *    where it suspended and re-runs the remaining statements for real.
 *  - `device-mode` gates whole feature families. The demo hEX runs `mode: home`,
 *    where `/system/scheduler/add` is answered with
 *    `failure: not allowed by device-mode (...)` printed on **stdout** while the
 *    exit status stays 0 and the rest of the line keeps running.
 *  - `/system/scheduler` entries live on the router, survive the SSH session and
 *    fire their stored `on-event` script after `interval` seconds — but only on a
 *    router whose device-mode allows the scheduler at all.
 *  - `on-event` is stored as a RouterOS *string literal*, so it is unescaped with
 *    RouterOS escape rules. Unknown escapes (`\;`) and unescaped `$` are rejected
 *    exactly as the real console would, which keeps the generated script honest.
 */

export class RouterOsScriptError extends Error {
  /**
   * Whatever the script already printed before it failed. A router cannot un-send
   * bytes that are already on the wire, so a refusal or a `:error` arrives *after*
   * the marker lines the same command produced.
   */
  readonly partialOutput: string;

  constructor(message: string, partialOutput = "") {
    super(message);
    this.name = "RouterOsScriptError";
    this.partialOutput = partialOutput;
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

/** Thrown by a background job's `:delay`; the job resumes on the next tick. */
class JobSuspended {
  constructor(readonly seconds: number) {}
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

export interface FakeJob {
  /** RouterOS internal id, minted by the router when the job is created. */
  id: string;
  /** The script text exactly as it was handed to `:execute`. */
  script: string;
  /** Index of the next statement to run. */
  cursor: number;
  /** Router time at which the job may run again. */
  wakeAtSeconds: number;
  startedAtSeconds: number;
}

/**
 * `/system/device-mode`. The demo hEX ships `mode: home`, i.e. `scheduler: no`.
 * `:execute` is a console primitive and is not gated, which is exactly why the
 * guard uses it — but the flag exists so a router that denied it can be tested.
 */
export interface FakeDeviceMode {
  scheduler: boolean;
  execute: boolean;
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
  /** A background job suspends on `:delay`; a console job blocks on it. */
  mode: "console" | "job";
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

/** The words RouterOS reads as true when a `!key` term negates a property. */
const ROUTER_OS_TRUE = new Set(["true", "yes"]);

interface RouterOsCriterion {
  key: string;
  /** `!key`, i.e. "this property is not true". */
  negated: boolean;
  value: string;
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
  readonly jobs: FakeJob[] = [];
  readonly deviceMode: FakeDeviceMode;
  readonly trace: string[] = [];
  identity = "demo-router";
  clockSeconds = 0;

  // Job ids live in their own table on a real router. They are minted well clear
  // of the fixture interface ids so a test can never pass by matching the wrong one.
  #nextJobId = 0x100;
  #jobVariables = new Map<string, Map<string, Value>>();
  #runningJobs = false;

  constructor(options: {
    interfaces: FakeInterface[];
    firewall?: Array<Record<string, string>>;
    scheduler?: FakeSchedulerEntry[];
    jobs?: Array<{ script: string }>;
    deviceMode?: Partial<FakeDeviceMode>;
  }) {
    this.interfaces = options.interfaces.map((entry) => ({ ...entry }));
    this.firewall = (options.firewall ?? []).map((entry) => ({ ...entry }));
    for (const entry of options.scheduler ?? []) this.scheduler.push({ ...entry });
    this.deviceMode = {
      // Matches the demo hEX (RouterOS 7.20.8, `mode: home`, `scheduler: no`).
      scheduler: options.deviceMode?.scheduler ?? false,
      execute: options.deviceMode?.execute ?? true,
    };
    for (const entry of options.jobs ?? []) this.#startJob(entry.script);
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
      mode: "console",
    };
    try {
      this.#runBlock(script, state);
    } catch (error) {
      if (error instanceof RouterOsSessionInterrupted) {
        throw new RouterOsSessionInterrupted(state.output.join(""));
      }
      if (error instanceof RouterOsScriptError) {
        throw new RouterOsScriptError(error.message, state.output.join(""));
      }
      throw error;
    }
    return state.output.join("");
  }

  /**
   * Moves router time forward, resumes every background job whose `:delay`
   * elapsed and fires every scheduler entry that became due.
   */
  advanceSeconds(seconds: number): void {
    this.clockSeconds += seconds;
    this.#runDueJobs();
    for (const entry of [...this.scheduler]) {
      if (!this.scheduler.includes(entry)) continue;
      if (this.clockSeconds - entry.armedAtSeconds < entry.intervalSeconds) continue;
      this.trace.push(`scheduler-fire:${entry.name}`);
      const state: ExecutionState = {
        variables: new Map(),
        output: [],
        allowDelay: false,
        interruptAtDelay: false,
        mode: "console",
      };
      this.#runBlock(entry.onEvent, state);
    }
  }

  #startJob(script: string): FakeJob {
    const job: FakeJob = {
      id: `*${(this.#nextJobId += 1).toString(16).toUpperCase()}`,
      script,
      cursor: 0,
      wakeAtSeconds: this.clockSeconds,
      startedAtSeconds: this.clockSeconds,
    };
    this.jobs.push(job);
    this.#jobVariables.set(job.id, new Map());
    this.trace.push(`job-start:${job.id}`);
    // `:execute` returns as soon as the job has been created, but the job itself
    // starts running immediately — so its leading `:delay` is measured from here.
    this.#stepJob(job);
    return job;
  }

  #removeJob(job: FakeJob): void {
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
    this.#jobVariables.delete(job.id);
  }

  #runDueJobs(): void {
    if (this.#runningJobs) return;
    this.#runningJobs = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const job of [...this.jobs]) {
          if (!this.jobs.includes(job)) continue;
          if (job.wakeAtSeconds > this.clockSeconds) continue;
          this.#stepJob(job);
          progressed = true;
        }
      }
    } finally {
      this.#runningJobs = false;
    }
  }

  /** Runs a job from its cursor until it suspends, fails or finishes. */
  #stepJob(job: FakeJob): void {
    const state: ExecutionState = {
      variables: this.#jobVariables.get(job.id) ?? new Map(),
      output: [],
      allowDelay: true,
      interruptAtDelay: false,
      mode: "job",
    };
    const list = statements(job.script);
    while (job.cursor < list.length) {
      const statement = list[job.cursor] ?? "";
      try {
        this.#runStatement(statement, state);
      } catch (error) {
        if (error instanceof JobSuspended) {
          job.cursor += 1;
          job.wakeAtSeconds = this.clockSeconds + error.seconds;
          this.trace.push(`job-delay:${job.id}:${error.seconds}`);
          return;
        }
        // A background job that errors simply dies, taking nothing else with it.
        this.trace.push(`job-error:${job.id}`);
        this.#removeJob(job);
        return;
      }
      job.cursor += 1;
    }
    this.trace.push(`job-end:${job.id}`);
    this.#removeJob(job);
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
      const seconds = Number(match[1]);
      if (state.mode === "job") throw new JobSuspended(seconds);
      if (!state.allowDelay) throw new RouterOsScriptError(":delay is not allowed here");
      this.trace.push(`delay:${match[1]}`);
      if (state.interruptAtDelay) throw new RouterOsSessionInterrupted(state.output.join(""));
      this.advanceSeconds(seconds);
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
    if (statement.startsWith("/system/script/job/remove ")) {
      const target = this.#evaluate(
        statement.slice("/system/script/job/remove ".length).trim(),
        state,
      );
      if (target.kind !== "ids") throw new RouterOsScriptError("expected a job selector");
      for (const id of target.ids) {
        const job = this.jobs.find((entry) => entry.id === id);
        if (!job) throw new RouterOsScriptError("failure: no such item");
        this.#removeJob(job);
        this.trace.push(`job-remove:${id}`);
      }
      return;
    }
    if (statement.startsWith("/system/scheduler add ")) {
      this.#addScheduler(statement.slice("/system/scheduler add ".length), state);
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

  #addScheduler(argumentText: string, state: ExecutionState): void {
    if (!this.deviceMode.scheduler) {
      // The hard fact this whole redesign turns on: RouterOS answers a
      // device-mode refusal on stdout, keeps the exit status at 0 and carries on
      // with the rest of the line.
      state.output.push("failure: not allowed by device-mode (/system/scheduler/add; line 1)\n");
      this.trace.push("scheduler-denied");
      return;
    }
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
    if (head === ":tostr") {
      return { kind: "string", value: primitive(this.#evaluate(parts.slice(1).join(" "), state)) };
    }
    if (head === ":execute") {
      return this.#executeJob(parts.slice(1), state);
    }
    if (head === "/interface/find") {
      return {
        kind: "ids",
        path: "/interface",
        ids: this.#findInterfaces(parts.slice(1), state).map((entry) => entry.id),
      };
    }
    if (head === "/system/script/job/find") {
      return {
        kind: "ids",
        path: "/system/script/job",
        ids: this.#findJobs(parts.slice(1), state).map((entry) => entry.id),
      };
    }
    if (head === "/ip/firewall/filter/find") {
      const criteria = this.#criteria(parts.slice(1), state);
      return {
        kind: "ids",
        path: "/ip/firewall/filter",
        ids: this.firewall
          .filter((record) => criteria.every(({ key, negated, value }) => (negated
            ? !ROUTER_OS_TRUE.has(record[key] ?? "")
            : (record[key] ?? "") === value)))
          .map((_record, index) => `*F${index}`),
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

  #executeJob(parts: string[], state: ExecutionState): Value {
    const argument = parts.join(" ");
    if (!argument.startsWith("script={") || !argument.endsWith("}")) {
      throw new RouterOsScriptError(":execute expects script={...}");
    }
    if (!this.deviceMode.execute) {
      state.output.push("failure: not allowed by device-mode (:execute; line 1)\n");
      this.trace.push("execute-denied");
      return { kind: "string", value: "" };
    }
    const script = argument.slice("script={".length, -1);
    // The stored text must itself be a script the console can parse later.
    statements(script);
    return { kind: "string", value: this.#startJob(script).id };
  }

  /**
   * `key=value` terms and the negated `!key` form. RouterOS reads `!dynamic` as
   * "the `dynamic` property is not true", which is why an absent property
   * satisfies it — a static row does not carry `dynamic=true`.
   */
  #criteria(parts: string[], state: ExecutionState): RouterOsCriterion[] {
    if ((parts[0] ?? "") !== "where") throw new RouterOsScriptError("expected where");
    const criteria: RouterOsCriterion[] = [];
    for (const token of parts.slice(1)) {
      if (token === "and") continue;
      if (token.startsWith("!")) {
        criteria.push({ key: token.slice(1), negated: true, value: "" });
        continue;
      }
      const separator = token.indexOf("=");
      if (separator <= 0) throw new RouterOsScriptError(`unsupported criterion ${token}`);
      criteria.push({
        key: token.slice(0, separator),
        negated: false,
        value: primitive(this.#evaluate(token.slice(separator + 1), state)),
      });
    }
    return criteria;
  }

  #findInterfaces(parts: string[], state: ExecutionState): FakeInterface[] {
    const criteria = this.#criteria(parts, state);
    return this.interfaces.filter((entry) => criteria.every(({ key, negated, value }) => {
      if (negated) throw new RouterOsScriptError(`unsupported interface criterion !${key}`);
      if (key === ".id") return entry.id === value;
      if (key === "name") return entry.name === value;
      if (key === "default-name") return entry.defaultName === value;
      if (key === "type") return entry.type === value;
      if (key === "disabled") return String(entry.disabled) === value;
      throw new RouterOsScriptError(`unsupported interface criterion ${key}`);
    }));
  }

  #findJobs(parts: string[], state: ExecutionState): FakeJob[] {
    const criteria = this.#criteria(parts, state);
    return this.jobs.filter((entry) => criteria.every(({ key, negated, value }) => {
      if (!negated && key === ".id") return entry.id === value;
      throw new RouterOsScriptError(`unsupported job criterion ${negated ? "!" : ""}${key}`);
    }));
  }

  #findScheduler(parts: string[], state: ExecutionState): FakeSchedulerEntry[] {
    const criteria = this.#criteria(parts, state);
    return this.scheduler.filter((entry) => criteria.every(({ key, negated, value }) => {
      if (negated) throw new RouterOsScriptError(`unsupported scheduler criterion !${key}`);
      if (key === "name") return entry.name === value;
      if (key === "comment") return entry.comment === value;
      throw new RouterOsScriptError(`unsupported scheduler criterion ${key}`);
    }));
  }
}
