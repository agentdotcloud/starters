// The Dockerfile agent.cloud would build a stack with when it has none of its own (BLD-1).
// Node: agent-cloud's own generator, vendored at the pinned commit. Python: the image agent-cloud's PYB-2 specifies
// (docs/specs/python-apps.md); this copy is replaced by the vendored generator once the platform ships it.
import { defaultDockerfile, forwarding } from '../vendor/agc/runner-build.ts';
import type { Language } from '../lib/stack.ts';

export function pythonDockerfile(command: string, hasUi: boolean): string {
  return [
    ...(hasUi ? [
      'FROM node:24-slim AS ui',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci',
      'COPY . .',
      'RUN npm run build',
      '',
    ] : []),
    'FROM python:3.12-slim',
    'COPY --from=ghcr.io/astral-sh/uv:0.12.19 /uv /usr/local/bin/uv',
    'WORKDIR /app',
    'ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUNBUFFERED=1 PGSSLROOTCERT=system',
    'COPY pyproject.toml uv.lock ./',
    'RUN uv sync --frozen --no-dev --no-install-project',
    'COPY . .',
    ...(hasUi ? ['COPY --from=ui /app/web/dist web/dist'] : []),
    'RUN uv sync --frozen --no-dev',
    'ENV PATH=/app/.venv/bin:$PATH',
    'RUN useradd --uid 1000 --create-home app',
    'USER app',
    `CMD ${JSON.stringify(forwarding(command))}`,
    '',
  ].join('\n');
}

export function dockerfileFor(language: Language, command: string | undefined, hasUi: boolean): string {
  if (language === 'node') return defaultDockerfile(command ?? null);
  if (!command) throw new Error('a Python app needs [service.web] command (agent-cloud PYB-4)');
  return pythonDockerfile(command, hasUi);
}

export { forwarding };
