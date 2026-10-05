import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getMe, logout, type Me } from "./api";
import { AdminLayout } from "./pages/Admin";
import { AuditPage } from "./pages/admin/AuditPage";
import { BrowsersPage } from "./pages/admin/BrowsersPage";
import { SessionsPage } from "./pages/admin/SessionsPage";
import { SettingsPage } from "./pages/admin/SettingsPage";
import { StoragePage } from "./pages/admin/StoragePage";
import { UsersPage } from "./pages/admin/UsersPage";
import { WorkersPage } from "./pages/admin/WorkersPage";
import { DashboardPage } from "./pages/Dashboard";
import { LoginPage } from "./pages/Login";
import { SessionPage } from "./pages/Session";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((next) => {
        if (!cancelled) setMe(next);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!me?.siteName) return;
    document.title = me.siteName;
  }, [me?.siteName]);

  useEffect(() => {
    const root = document.documentElement;
    if (me?.darkMode) root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
  }, [me?.darkMode]);

  async function onLogout() {
    if (!me) return;
    await logout(me.csrfToken);
    setMe(null);
  }

  if (me === undefined) {
    return <p className="status">Checking session…</p>;
  }


  return (
    <Routes>
      <Route
        path="/login"
        element={me ? <Navigate to="/" replace /> : <LoginPage onSuccess={setMe} />}
      />
      <Route
        path="/"
        element={
          me ? (
            <DashboardPage me={me} onLogout={onLogout} onMe={setMe} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/session/:sessionId"
        element={
          me ? (
            <SessionPage me={me} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/admin"
        element={
          !me ? (
            <Navigate to="/login" replace />
          ) : me.role !== "admin" ? (
            <Navigate to="/" replace />
          ) : (
            <AdminLayout me={me} onLogout={onLogout} onMe={setMe} />
          )
        }
      >
        <Route index element={<Navigate to="sessions" replace />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="workers" element={<WorkersPage />} />
        <Route path="storage" element={<StoragePage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="browsers" element={<BrowsersPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/admin/sessions" replace />} />
      </Route>
      <Route path="*" element={<Navigate to={me ? "/" : "/login"} replace />} />
    </Routes>
  );
}
