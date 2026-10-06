// Results: each test reports pass, fail or skip with evidence, for every rule that names it, or per rule when one test
// proves several rules separately. A rule passes when all its tests pass, fails when any fails, and is marked
// `review` when only a person can check it.
import type { Level, Rule } from './spec.ts';

export type Outcome = 'pass' | 'fail' | 'skip';
export interface Verdict { outcome: Outcome; evidence: string }
// A test's result: one verdict for every rule that names it, plus any rule-specific overrides.
export interface TestResult extends Verdict { perRule?: Record<string, Verdict> }

export const pass = (evidence: string, perRule?: Record<string, Verdict>): TestResult => ({ outcome: 'pass', evidence, ...(perRule ? { perRule } : {}) });
export const fail = (evidence: string, perRule?: Record<string, Verdict>): TestResult => ({ outcome: 'fail', evidence, ...(perRule ? { perRule } : {}) });
export const skip = (evidence: string): TestResult => ({ outcome: 'skip', evidence });
// A verdict for one rule inside a test that proves several.
export const verdict = (ok: boolean, evidence: string): Verdict => ({ outcome: ok ? 'pass' : 'fail', evidence });

export interface RuleReport { id: string; level: Level; outcome: Outcome | 'review'; evidence: string[] }

export function judge(rules: Rule[], results: Map<string, TestResult>): RuleReport[] {
  return rules.map((r) => {
    const verdicts = r.tests.filter((t) => results.has(t)).map((t) => {
      const res = results.get(t)!;
      return { test: t, ...(res.perRule?.[r.id] ?? res) };
    });
    if (!r.tests.length) return { id: r.id, level: r.level, outcome: 'review', evidence: ['checked by a person in the starter’s PR'] };
    const evidence = verdicts.map((v) => `${v.test}: ${v.evidence}`);
    const missing = r.tests.filter((t) => !results.has(t));
    if (verdicts.some((v) => v.outcome === 'fail')) return { id: r.id, level: r.level, outcome: 'fail', evidence };
    if (!verdicts.length || verdicts.every((v) => v.outcome === 'skip')) {
      return { id: r.id, level: r.level, outcome: 'skip', evidence: [...evidence, ...missing.map((t) => `${t}: not run`)] };
    }
    if (verdicts.some((v) => v.outcome === 'skip') || missing.length) {
      return { id: r.id, level: r.level, outcome: 'skip', evidence: [...evidence, ...missing.map((t) => `${t}: not run`)] };
    }
    return { id: r.id, level: r.level, outcome: 'pass', evidence: r.review ? [...evidence, 'and a person checks it in review'] : evidence };
  });
}

// A failed MUST fails the run; a SHOULD only reports.
export const failedMusts = (report: RuleReport[]) => report.filter((r) => r.outcome === 'fail' && r.level === 'MUST');

export function render(stack: string, report: RuleReport[]): string {
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', review: 'REVIEW' } as const;
  const lines = [`conformance: ${stack}`, ''];
  for (const r of report) {
    lines.push(`${mark[r.outcome].padEnd(6)} ${r.id.padEnd(8)} ${r.level === 'SHOULD' ? '(should) ' : ''}${r.evidence[0] ?? ''}`);
    for (const e of r.outcome === 'pass' ? [] : r.evidence.slice(1)) lines.push(`${''.padEnd(16)}${e}`);
  }
  const count = (o: string) => report.filter((r) => r.outcome === o).length;
  lines.push('', `${count('pass')} passed, ${failedMusts(report).length} MUST failed, ${count('fail') - failedMusts(report).length} SHOULD failed, ${count('skip')} skipped, ${count('review')} for review`);
  return lines.join('\n');
}
