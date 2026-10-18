import { createContext, ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import InfoTip from "./InfoTip";
import { lastSession } from "./lastSession";

/**
 * Where a component deep in the page can put its controls: the end of the panel body. `undefined` = the page has no panel
 * (the controls then stay where they are written), `null` = the panel is collapsed (they are not shown).
 */
const PanelSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * Children of the page that own their own controls (a view with state of its own) write them with `PanelPortal`: they
 * appear in the options panel while it is open, nothing is shown while it is collapsed, and on a page without a panel
 * (or when rendered alone, in a test) they simply stay inline.
 */
export function PanelPortal({ children }: { children: ReactNode }) {
  const slot = useContext(PanelSlot);
  if (slot === undefined) return <>{children}</>;
  if (slot === null) return null;
  return createPortal(children, slot);
}

/** A titled block of controls in the panel, for the view that is on show (with the info tip of the other pages' tools). */
export function PanelSection({ title, info, children, testId }: { title: string; info?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="tool-controls" data-testid={testId}>
      <h3 className="tool-controls-title">
        {title}
        {info && <InfoTip label={title}>{info}</InfoTip>}
      </h3>
      {children}
    </section>
  );
}

/**
 * A page body with a collapsible options panel on its right. Whether it is collapsed is remembered for every page.
 * An optional status card sits above the panel, at the top of the right-hand column (shown while the panel is open).
 * `wide` is for pages whose panel holds longer controls. The page's own children can add to the panel with `PanelPortal`.
 */
export default function SidePanel({ panel, card, wide = false, children }: { panel: ReactNode; card?: ReactNode; wide?: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(lastSession.panelCollapsed);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const toggle = () => {
    lastSession.setPanelCollapsed(!collapsed);
    setCollapsed(!collapsed);
  };
  return (
    <div className="with-panel">
      <div className="with-panel-main">
        <PanelSlot.Provider value={collapsed ? null : slot}>{children}</PanelSlot.Provider>
      </div>
      <div className={`right-col${collapsed ? " collapsed" : ""}${wide ? " wide" : ""}`}>
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
        {!collapsed && (
          <div className="right-panel-body">
            {panel}
            <div ref={setSlot} data-testid="panel-slot" />
          </div>
        )}
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
