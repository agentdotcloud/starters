// The Dockerfile agent.cloud would build a stack with when it has none of its own (BLD-1): agent-cloud's own
// generators, vendored at the pinned commit (Node's default, and Python's for uv projects).
import { defaultDockerfile, forwarding, pythonDockerfile } from '../vendor/agc/runner-build.ts';
import type { Language } from '../lib/stack.ts';

export function dockerfileFor(language: Language, command: string | undefined, hasUi: boolean): string {
  if (language === 'node') return defaultDockerfile(command ?? null);
  if (!command) throw new Error('a Python app needs [service.web] command (agent-cloud PYB-4)');
  return pythonDockerfile(command, hasUi);
}

export { forwarding };
