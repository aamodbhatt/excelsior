import { useEffect, useState } from 'react';
import { type User, type WorkbookMeta, api } from '../api';

const TEMPLATES = [
  {
    id: 'neural-net',
    title: 'Train a neural net',
    blurb: 'A 2-layer MLP learns two spirals by iterative calculation: one gradient step per iteration.',
  },
  {
    id: 'transformer',
    title: 'A transformer in a sheet',
    blurb: 'A 27k-parameter char-level GPT. Type a prompt, watch every attention head.',
  },
  {
    id: 'blank',
    title: 'Blank workbook',
    blurb: 'Formulas, dynamic arrays, LAMBDA, charts and real-time collaboration.',
  },
] as const;

export function Home({
  user,
  onOpen,
  onLogout,
}: {
  user: User;
  onOpen: (id: string) => void;
  onLogout: () => void;
}) {
  const [books, setBooks] = useState<WorkbookMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.list().then((r) => setBooks(r.workbooks));
  }, []);

  const create = async (template: (typeof TEMPLATES)[number]['id'], title: string) => {
    setBusy(template);
    const { id } = await api.create(title, template);
    onOpen(id);
  };

  return (
    <div className="home">
      <header className="home-head">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <h1>excelsior</h1>
        <div className="spacer" />
        <span className="muted">{user.name}</span>
        <button type="button" className="btn" onClick={onLogout}>
          Sign out
        </button>
      </header>
      <section className="templates">
        {TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.id}
            className="template"
            disabled={!!busy}
            onClick={() => void create(t.id, t.title)}
            data-testid={`new-${t.id}`}
          >
            <span className="template-title">{t.title}</span>
            <span className="template-blurb">{t.blurb}</span>
            {busy === t.id && <span className="muted">Creating…</span>}
          </button>
        ))}
      </section>
      <h2 className="section-title">Your workbooks</h2>
      <ul className="books">
        {books?.length === 0 && <li className="muted">Nothing yet. Start from a template above.</li>}
        {books?.map((b) => (
          <li key={b.id}>
            <button type="button" className="book" onClick={() => onOpen(b.id)}>
              <span>{b.title}</span>
              <span className="muted">
                {b.role} · v{b.version} · {new Date(b.updatedAt).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
