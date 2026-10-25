import { Component, ErrorInfo, ReactNode } from "react";
import { flushNow, report } from "./clientLog";

interface State {
  error: Error | null;
}

/** Catches a crash while rendering, reports it with the component stack and offers a reload instead of a blank page. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    report("error", `Render crash: ${error.message}`, { stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}` });
    void flushNow();
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="error-boundary" style={{ padding: 24 }}>
        <h2>Something went wrong on this page</h2>
        <p>{this.state.error.message}</p>
        <p>The error was written to the log (Status → Log). Your data is not affected.</p>
        <button type="button" onClick={() => this.setState({ error: null })}>Try again</button>{" "}
        <button type="button" onClick={() => location.reload()}>Reload the app</button>
      </div>
    );
  }
}
