import { ReactNode, useState } from "react";
import { lastSession } from "./lastSession";

/** A page body with a collapsible options panel on its right. Whether it is collapsed is remembered for every page. */
export default function SidePanel({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(lastSession.panelCollapsed);
  const toggle = () => {
    lastSession.setPanelCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  return (
    <div className="with-panel">
      <div className="with-panel-main">{children}</div>
      <aside aria-label="Options" className={`right-panel${collapsed ? " collapsed" : ""}`}>
        <button
          type="button"
          className="right-panel-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Show options panel" : "Hide options panel"}
          title={collapsed ? "Show options panel" : "Hide options panel"}
          onClick={toggle}
        >
          {collapsed ? "«" : "»"}
        </button>
        {!collapsed && <div className="right-panel-body">{panel}</div>}
      </aside>
    </div>
  );
}

/** A titled, collapsible group of related controls inside the panel. */
export function PanelGroup({ title, defaultOpen = true, children, testId }: { title: string; defaultOpen?: boolean; children: ReactNode; testId?: string }) {
  return (
    <details className="panel-group" open={defaultOpen} data-testid={testId}>
      <summary>{title}</summary>
      {children}
    </details>
  );
}
