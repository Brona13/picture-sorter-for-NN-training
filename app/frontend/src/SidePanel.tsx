import { ReactNode, useState } from "react";
import InfoTip from "./InfoTip";
import { lastSession } from "./lastSession";

/**
 * A page body with a collapsible options panel on its right. Whether it is collapsed is remembered for every page.
 * An optional status card sits above the panel, at the top of the right-hand column (shown while the panel is open).
 */
export default function SidePanel({ panel, card, children }: { panel: ReactNode; card?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(lastSession.panelCollapsed);
  const toggle = () => {
    lastSession.setPanelCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  return (
    <div className="with-panel">
      <div className="with-panel-main">{children}</div>
      <div className={`right-col${collapsed ? " collapsed" : ""}`}>
      {!collapsed && card && <div className="stat-card">{card}</div>}
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
  info,
  children,
  testId,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  active?: boolean;
  /** What the function does, shown when hovering the "i" icon in the title row. */
  info?: ReactNode;
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
        {info && <InfoTip label={title}>{info}</InfoTip>}
      </summary>
      {children}
    </details>
  );
}
