// Every test SPEC.md names exists, every test that exists is named by a rule, and every rule is proven somehow.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONF_TESTS } from '../conf/index.ts';
import { lint } from '../lint/index.ts';
import { readRules } from '../lib/spec.ts';

const rules = readRules(join(import.meta.dirname, '..', '..', 'SPEC.md'));
const implemented = new Set([...Object.keys(lint), ...CONF_TESTS]);

test('the spec has its rules, each with a test or a review', () => {
  assert.ok(rules.length >= 60, `${rules.length} rules`);
  for (const r of rules) assert.ok(r.tests.length || r.review, `${r.id} has no test and isn't marked review`);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, 'rule IDs are unique');
});

test('every test the spec names is implemented', () => {
  const named = new Set(rules.flatMap((r) => r.tests));
  for (const t of named) assert.ok(implemented.has(t), `${t} is named in SPEC.md but not implemented`);
});

test('every implemented test is named by a rule', () => {
  const named = new Set(rules.flatMap((r) => r.tests));
  for (const t of implemented) assert.ok(named.has(t), `${t} is implemented but no rule names it`);
});
