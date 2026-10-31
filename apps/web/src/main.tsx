import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type ApiError, type User, api } from './api';
import { Editor } from './editor/Editor';
import { Auth } from './pages/Auth';
import { Home } from './pages/Home';
import './styles.css';

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const go = (p: string) => {
    history.pushState(null, '', p);
    setPath(p);
  };
  return [path, go];
}

function App() {
  const [path, go] = usePath();
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);

  useEffect(() => {
    const share = /^\/s\/([\w-]+)$/.exec(path);
    if (share && user) {
      api.acceptShare(share[1]).then(
        (r) => go(`/w/${r.workbookId}`),
        (e: ApiError) => alert(e.message),
      );
    }
  }, [path, user]);

  if (user === undefined) return <div className="loading">Loading…</div>;
  if (!user) {
    return (
      <Auth
        onDone={(u) => {
          setUser(u);
          if (path === '/login') go('/');
        }}
      />
    );
  }
  const wb = /^\/w\/([\w-]+)$/.exec(path);
  if (wb) return <Editor key={wb[1]} workbookId={wb[1]} onHome={() => go('/')} />;
  return (
    <Home
      user={user}
      onOpen={(id) => go(`/w/${id}`)}
      onLogout={async () => {
        await api.logout();
        setUser(null);
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
