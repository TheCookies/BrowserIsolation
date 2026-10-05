import { useOutletContext } from "react-router-dom";
import type { Me } from "../../api";

export type AdminOutletContext = {
  me: Me;
  onLogout: () => Promise<void>;
  onMe: (me: Me) => void;
};

export function useAdminContext(): AdminOutletContext {
  return useOutletContext<AdminOutletContext>();
}
