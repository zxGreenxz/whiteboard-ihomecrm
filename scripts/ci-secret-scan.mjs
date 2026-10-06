#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
if (!Number.isInteger(count) || count < 500) throw new Error(`Incomplete secret-scan history: ${count} commits (minimum 500)`);
execFileSync('/tmp/gitleaks', ['git', '--redact', '--no-banner', '--config', '.gitleaks.toml', '.'], { stdio: 'inherit' });
