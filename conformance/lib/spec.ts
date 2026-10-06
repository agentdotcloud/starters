// The rules, read from SPEC.md itself: each `- **ID:**` or `- **ID (SHOULD):**` line, and the tests its text names
// (`LINT:name`, `CONF:name`). The suite reports every rule the spec has, so a rule nobody tests can't go unnoticed.
import { readFileSync } from 'node:fs';

export type Level = 'MUST' | 'SHOULD';
export interface Rule { id: string; level: Level; text: string; tests: string[]; review: boolean }

const RULE = /^- \*\*([A-Z]+-\d+)( \(SHOULD\))?:\*\* (.*)$/;
const TEST = /`((?:LINT|CONF):[a-z0-9-]+)`/g;

export function readRules(specPath: string): Rule[] {
  const rules: Rule[] = [];
  let current: Rule | null = null;
  for (const line of readFileSync(specPath, 'utf8').split('\n')) {
    const m = RULE.exec(line);
    if (m) {
      current = { id: m[1]!, level: m[2] ? 'SHOULD' : 'MUST', text: m[3]!, tests: [], review: false };
      rules.push(current);
    } else if (current && (/^\s+\S/.test(line) || line.trim() === '')) {
      current.text += `\n${line}`; // a rule's continuation lines (lists, code) belong to it
    } else current = null;
  }
  for (const r of rules) {
    r.tests = [...new Set([...r.text.matchAll(TEST)].map((t) => t[1]!))];
    r.review = /`review`/.test(r.text);
  }
  return rules;
}
