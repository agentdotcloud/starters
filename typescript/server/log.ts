// Logs are one JSON object per line on stdout, with a level: agent.cloud's observability reads `level`, and a
// workflow event (`{"agc":"event",…}`) becomes a step in the console's replay. Never log personal data: no emails,
// names or tokens, at any level. Ids and counts are fine.
type Fields = Record<string, unknown>;

function write(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields: Fields = {}) {
  const line = JSON.stringify({ level, msg, ...fields, time: new Date().toISOString() });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

// A business step: `name` is lowercase.dotted, `entity` is type:id with an opaque id (a uuid or number, never an email).
export function event(name: string, entity: string, opts: { related?: string[]; status?: 'ok' | 'failed'; attrs?: Fields } = {}) {
  process.stdout.write(`${JSON.stringify({ agc: 'event', name, entity, related: opts.related ?? [], status: opts.status ?? 'ok', attrs: opts.attrs ?? {} })}\n`);
}
