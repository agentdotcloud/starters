// The conformance suite: does a stack follow SPEC.md?
//
//   node conformance/run.ts <stack-dir> [--lint-only] [--no-dev] [--json report.json]
//
// Lints the files, then builds the stack with agent.cloud's default image and runs it against a fake platform.
// Prints one line per rule (PASS, FAIL with evidence, SKIP with the reason, REVIEW for a person), and exits 1 if any
// MUST rule fails. CONFORMANCE_KEEP=1 leaves the containers running for a look.
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conform } from './conf/index.ts';
import { lint } from './lint/index.ts';
import { failedMusts, judge, render, type TestResult } from './lib/report.ts';
import { readRules } from './lib/spec.ts';
import { readStack } from './lib/stack.ts';

const SPEC = join(dirname(fileURLToPath(import.meta.url)), '..', 'SPEC.md');

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--json');
  if (!dir) {
    console.error('usage: node conformance/run.ts <stack-dir> [--lint-only] [--no-dev] [--json report.json]');
    process.exit(2);
  }
  const jsonAt = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
  const stack = await readStack(resolve(dir));
  const rules = readRules(SPEC);
  const results = new Map<string, TestResult>();
  for (const [name, test] of Object.entries(lint)) {
    try {
      results.set(name, test(stack));
    } catch (e) {
      results.set(name, { outcome: 'fail', evidence: `the check itself failed: ${(e as Error).message}` });
    }
  }
  if (!args.includes('--lint-only')) {
    const log = (m: string) => console.error(`  ${m}`);
    for (const [k, v] of await conform(stack, { dev: !args.includes('--no-dev'), log })) results.set(k, v);
  }
  const report = judge(rules, results);
  console.log(render(`${dir} (${stack.language})`, report));
  if (jsonAt) writeFileSync(jsonAt, JSON.stringify({ stack: dir, language: stack.language, rules: report }, null, 2));
  process.exit(failedMusts(report).length ? 1 : 0);
}

main().catch((e) => {
  console.error(`conformance couldn’t run: ${(e as Error).stack ?? e}`);
  process.exit(2);
});
