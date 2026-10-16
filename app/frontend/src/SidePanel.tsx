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

/**
 * A titled, collapsible group of related controls inside the panel. The page owns whether it is
 * open, and which group is the active function (shown with a tinted background and a tag).
 */
export function PanelGroup({
  title,
  open,
  onOpenChange,
  active = false,
  children,
  testId,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details
      className={`panel-group${active ? " active" : ""}`}
      open={open}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      onToggle={(e) => {
        if (e.currentTarget.open !== open) onOpenChange(e.currentTarget.open);
      }}
    >
      <summary>
        {title}
        {active && <span className="panel-group-tag"> ● active</span>}
      </summary>
      {children}
    </details>
  );
}
