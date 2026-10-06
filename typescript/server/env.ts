// What the process needs from its environment. agent.cloud sets all of these, on a mirror and in production; a missing
// one stops the process at once, with its name on the last line, so agent.cloud can say exactly what's wrong.
export function required(...names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (!value) {
      process.stderr.write(`${JSON.stringify({ level: 'error', msg: `${name} is not set` })}\n`);
      process.exit(1);
    }
    out[name] = value;
  }
  return out;
}

// On a mirror (agc up), cookies can't be Secure: the app is served over http://localhost.
export const onMirror = Boolean(process.env.AGENTCLOUD_MIRROR);
