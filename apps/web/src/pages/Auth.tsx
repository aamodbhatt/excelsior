import { useState } from 'react';
import { type User, api } from '../api';

export function Auth({ onDone }: { onDone: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === 'signup' ? await api.signup(email, name, password) : await api.login(email, password);
      onDone(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-hero">
        <img src="/favicon.svg" alt="" width={48} height={48} />
        <h1>excelsior</h1>
        <p>
          A spreadsheet engine built from scratch, fast enough to train a neural network inside its cells.
        </p>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>
        {mode === 'signup' && (
          <label>
            Name
            <input
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoComplete="name"
            />
          </label>
        )}
        <label>
          Email
          <input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn-primary btn-wide" disabled={busy}>
          {mode === 'signup' ? 'Sign up' : 'Sign in'}
        </button>
        <button
          type="button"
          className="link"
          onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}
        >
          {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </form>
    </div>
  );
}
