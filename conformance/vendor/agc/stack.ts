// What kind of app this is, the way agent.cloud builds it (docs/specs/python-apps.md PYB-1): its own Dockerfile, a uv
// project (Python), or Node. Shared by agc, the control plane and the runner, so all three agree. No imports: the runner's
// image carries no dependencies.

export type Stack = 'dockerfile' | 'python' | 'node';

// PYB-1: a uv project is a root pyproject.toml whose [project] table declares dependencies. A Node app's tool-only
// pyproject.toml (ruff or black settings, optional groups) isn't one.
export function uvProject(pyproject: string | null | undefined): boolean {
  if (!pyproject) return false;
  let inProject = false;
  for (const raw of pyproject.split('\n')) {
    const line = raw.replace(/\s#.*$/, '').trim();
    const table = /^\[\s*([^\][]+?)\s*\]$/.exec(line);
    if (table) {
      inProject = table[1] === 'project';
      continue;
    }
    if (line.startsWith('[')) inProject = false; // [[array.of.tables]]
    if (/^project\.dependencies\s*=/.test(line) || (inProject && /^dependencies\s*=/.test(line))) return true;
  }
  return false;
}

export function stackOf(has: (name: string) => boolean, pyproject: string | null | undefined): Stack {
  if (has('Dockerfile')) return 'dockerfile';
  return uvProject(pyproject) ? 'python' : 'node';
}
