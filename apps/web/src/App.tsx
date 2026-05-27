import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { MigrationStep1 } from './pages/MigrationStep1';
import { MigrationStep2 } from './pages/MigrationStep2';
import { MigrationStep3 } from './pages/MigrationStep3';
import { YourMigration } from './pages/YourMigration';
import { BulkStep1 } from './pages/BulkStep1';
import { Settings } from './pages/Settings';
import { ChangePassword } from './pages/ChangePassword';

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .me()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center text-primary font-bold">
        Loading…
      </div>
    );
  }
  if (!authed) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSuccess={() => setAuthed(true)} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route
        element={
          <Layout
            onLogout={async () => {
              await api.logout();
              setAuthed(false);
            }}
          />
        }
      >
        <Route path="/" element={<Overview />} />
        <Route path="/migrations/new" element={<MigrationStep1 />} />
        <Route path="/migrations/new/step2" element={<MigrationStep2 />} />
        <Route path="/migrations/:id/progress" element={<MigrationStep3 />} />
        <Route path="/migrations/:id" element={<YourMigration />} />
        <Route path="/bulk/new" element={<BulkStep1 />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/change-password" element={<ChangePassword />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
