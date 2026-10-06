import { type FormEvent, useEffect, useState } from 'react';
import { api, type Note, type User } from './api.ts';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.me().then((r) => setUser(r.data?.user ?? null));
  }, []);
  useEffect(() => {
    if (user) void api.notes().then((r) => setNotes(r.data ?? []));
  }, [user]);

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await api.add(title);
    if (r.data) {
      setNotes([r.data, ...notes]);
      setTitle('');
      setError('');
    } else setError(r.error ?? 'Couldn’t save the note.');
  }

  if (user === undefined) return <main className="page" />;
  if (!user) {
    return (
      <main className="page center">
        <h1>Notes</h1>
        <p className="muted">Keep notes, and get an email for each one.</p>
        <a className="button" href="/auth/sign-in">Sign in</a>
      </main>
    );
  }
  return (
    <main className="page">
      <header className="bar">
        <h1>Your notes</h1>
        <button className="link" onClick={() => void api.signOut().then(() => setUser(null))}>Sign out</button>
      </header>
      <form className="add" onSubmit={(e) => void add(e)}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A new note" maxLength={200} aria-label="Note title" />
        <button className="button" disabled={!title.trim()}>Add</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="notes">
        {notes.map((n) => <li key={n.id}><span>{n.title}</span><time dateTime={n.created_at}>{new Date(n.created_at).toLocaleString()}</time></li>)}
        {!notes.length && <li className="muted">No notes yet.</li>}
      </ul>
    </main>
  );
}
