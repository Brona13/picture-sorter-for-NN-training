import { useEffect, useState } from "react";
import { api, MethodsConfig } from "../api";

/**
 * App-wide settings. For now: which scoring methods take part in the flow. A method that is off is not
 * computed (so a refresh is faster) and disappears from Classify, Insights and the card flags; nothing is
 * deleted, so switching it back on only needs a refresh.
 */
export default function ConfigurationView() {
  const [config, setConfig] = useState<MethodsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .configMethods()
      .then(setConfig)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const active = config?.methods.filter((m) => m.active).map((m) => m.id) ?? [];

  async function toggle(id: string, on: boolean) {
    if (!config) return;
    const next = on ? [...active, id] : active.filter((m) => m !== id);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      setConfig(await api.configSetMethods(next));
      setNotice(
        on
          ? "Switched on. Run Refresh scores in Classify once so this method gets its scores."
          : "Switched off. It is no longer computed or shown; nothing was deleted.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>⚙️ Configuration</h2>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <h3>Scoring methods</h3>
      <p style={{ fontSize: 13 }}>
        Tick the methods that take part in the flow. A method that is off is not computed, which makes <strong>Refresh scores</strong> faster, and it
        disappears from Classify (flags, ranking), Insights, version statistics and, for the ResNets, from Dedup, Outliers and Find similar. The setting is
        shared by all cameras. At least one method stays on.
      </p>
      {!config ? (
        <p>Loading…</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "8px 0", maxWidth: 720 }}>
          {config.methods.map((m) => {
            const last = m.active && active.length === 1;
            return (
              <li key={m.id} style={{ margin: "0 0 10px" }}>
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", opacity: m.installed ? 1 : 0.55 }}>
                  <input
                    type="checkbox"
                    aria-label={m.label}
                    checked={m.active}
                    disabled={saving || !m.installed || last}
                    title={last ? "At least one method must stay on" : undefined}
                    onChange={(e) => void toggle(m.id, e.target.checked)}
                    style={{ marginTop: 4 }}
                  />
                  <span>
                    <strong>{m.label}</strong> <span style={{ color: "var(--muted)", fontSize: 12 }}>({m.tag} on the cards)</span>
                    <br />
                    <span style={{ fontSize: 13 }}>{m.description}</span>
                    {m.reason && (
                      <>
                        <br />
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>Not available here: {m.reason}</span>
                      </>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {config && <p style={{ fontSize: 12, color: "var(--muted)" }}>The ResNet methods run on: {config.device_label}.</p>}
    </section>
  );
}
