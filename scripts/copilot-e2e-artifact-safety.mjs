import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pipeline, Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const SECRET_NAME = /^(?:FLEET_PASS_|COPILOT_E2E_PIN$|VERCEL_AUTOMATION_BYPASS_SECRET$)/;
const JWT_SOURCE = String.raw`(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])`;
export const AUTHORIZATION_REDACTION_MARKER = '[REDACTED_AUTHORIZATION]';
// Logs are unstructured: commas, quotes and escapes can all belong to credentials.
// Suppress the entire physical-line suffix, including adjacent diagnostic fields,
// instead of guessing where a serialized header value ends.
const AUTHORIZATION_SOURCE = String.raw`(["']?authorization["']?[ \t]*[:=][ \t]*)([^\r\n]*)`;
const ENCODED_REPORT = 'data:application/zip;base64,';

function secretEntries(env) {
  return Object.keys(env)
    .filter((name) => SECRET_NAME.test(name))
    .map((name) => ({ name, value: env[name] }))
    .filter((entry) => typeof entry.value === 'string' && entry.value.length > 0);
}

function redactionEntries(env) {
  return secretEntries(env)
    .filter(({ name, value }) => value.length >= (name === 'COPILOT_E2E_PIN' ? 4 : 8))
    .sort((left, right) => right.value.length - left.value.length);
}

function redactAuthorization(text) {
  return text.replace(
    new RegExp(AUTHORIZATION_SOURCE, 'giu'),
    (_match, prefix, value) => {
      // A following line may contain the credential. Stop the stream instead of
      // emitting a trusted marker and then forwarding an unowned continuation.
      if (!value.trim()) throw new Error('Authorization value is not on the same diagnostic line');
      return `${prefix}${AUTHORIZATION_REDACTION_MARKER}`;
    },
  );
}

function hasUnsafeAuthorization(text) {
  for (const match of text.matchAll(new RegExp(AUTHORIZATION_SOURCE, 'giu'))) {
    const value = match[2].trim();
    if (value !== AUTHORIZATION_REDACTION_MARKER) return true;
  }
  return false;
}

export function redactCopilotE2EText(value, { env = process.env } = {}) {
  let text = String(value);
  for (const secret of redactionEntries(env)) text = text.split(secret.value).join('***');
  text = redactAuthorization(text);
  return text.replace(new RegExp(JWT_SOURCE, 'gu'), '[REDACTED_JWT]');
}

export function createCopilotE2ERedactor({ env = process.env } = {}) {
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        remainder += decoder.write(chunk);
        const lines = remainder.split('\n');
        remainder = lines.pop() ?? '';
        for (const line of lines) this.push(`${redactCopilotE2EText(line, { env })}\n`);
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        remainder += decoder.end();
        if (remainder) this.push(redactCopilotE2EText(remainder, { env }));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

export function inspectCopilotE2EArtifactDirectory(directory, { env = process.env } = {}) {
  const root = resolve(directory);
  const secrets = secretEntries(env);
  const findings = [];
  if (!existsSync(root)) {
    return {
      findings: [{ code: 'missing-directory', file: '.', detail: 'artifact directory missing' }],
      passwordSecretCount: secrets.filter(({ name }) => name.startsWith('FLEET_PASS_')).length,
    };
  }
  for (const file of filesUnder(root)) {
    const display = relative(root, file) || '.';
    let content;
    try {
      content = readFileSync(file);
    } catch {
      findings.push({ code: 'unreadable-file', file: display, detail: 'cannot inspect' });
      continue;
    }
    for (const secret of secrets) {
      if (content.includes(Buffer.from(secret.value))) {
        findings.push({ code: 'known-secret', file: display, detail: secret.name });
      }
    }
    const text = content.toString('utf8');
    if (new RegExp(JWT_SOURCE, 'u').test(text)) {
      findings.push({ code: 'dynamic-jwt', file: display, detail: 'JWT-shaped value' });
    }
    if (hasUnsafeAuthorization(text)) {
      findings.push({ code: 'authorization-header', file: display, detail: 'unredacted header' });
    }
    if (content.includes(Buffer.from(ENCODED_REPORT))) {
      findings.push({ code: 'encoded-report', file: display, detail: 'embedded zip cannot be inspected' });
    }
  }
  return {
    findings,
    passwordSecretCount: secrets.filter(({ name }) => name.startsWith('FLEET_PASS_')).length,
  };
}

function runGuard(directory) {
  const result = inspectCopilotE2EArtifactDirectory(directory);
  if (result.passwordSecretCount === 0) {
    console.error('KHONG DO DUOC: guard khong thay bien FLEET_PASS_* nao trong moi truong.');
    process.exitCode = 3;
    return;
  }
  if (result.findings.length > 0) {
    for (const finding of result.findings) {
      console.error(`::error::artifact unsafe (${finding.code}) at ${finding.file}: ${finding.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Guard: da do ${secretEntries(process.env).length} gia tri bi mat (${result.passwordSecretCount} mat khau DEMO), artifact sach.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'guard') runGuard(process.argv[3] ?? '');
  else pipeline(process.stdin, createCopilotE2ERedactor(), process.stdout, error => {
    if (error) {
      console.error('Copilot E2E log redaction failed; output suppressed.');
      process.exitCode = 1;
    }
  });
}
