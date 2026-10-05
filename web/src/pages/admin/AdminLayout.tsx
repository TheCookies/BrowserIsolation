import { NavLink, Outlet } from "react-router-dom";
import type { Me } from "../../api";
import { Shell } from "../../Shell";
import type { AdminOutletContext } from "./context";

const SUBNAV: Array<{ to: string; label: string }> = [
  { to: "/admin/sessions", label: "Sessions" },
  { to: "/admin/workers", label: "Workers" },
  { to: "/admin/storage", label: "Storage" },
  { to: "/admin/users", label: "Users" },
  { to: "/admin/browsers", label: "Browsers" },
  { to: "/admin/settings", label: "Settings" },
  { to: "/admin/audit", label: "Audit" },
];

export function AdminLayout({
  me,
  onLogout,
  onMe,
}: {
  me: Me;
  onLogout: () => Promise<void>;
  onMe: (me: Me) => void;
}) {
  const context: AdminOutletContext = { me, onLogout, onMe };
  return (
    <Shell me={me} onLogout={onLogout} onMe={onMe}>
      <nav className="admin-subnav" aria-label="Admin sections">
        {SUBNAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Outlet context={context} />
    </Shell>
  );
}
