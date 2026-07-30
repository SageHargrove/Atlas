import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

/* Without this, any render-time error unmounts the tree and you get a blank white page. */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error(err, info.componentStack); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ font: "14px/1.5 ui-monospace, monospace", padding: 32, color: "#e6edf3", background: "#0d1117", minHeight: "100vh" }}>
        <h2 style={{ margin: "0 0 8px" }}>Atlas hit a rendering error</h2>
        <p style={{ color: "#8fa3ba" }}>The details are below and in the browser console.</p>
        <pre style={{ whiteSpace: "pre-wrap", background: "#161b22", padding: 16, borderRadius: 8 }}>
          {String(this.state.err?.stack || this.state.err)}
        </pre>
        <button onClick={() => location.reload()} style={{ padding: "8px 14px", borderRadius: 8, cursor: "pointer" }}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <Boundary><App /></Boundary>
);

/* Installable app + instant reopen. The worker caches only the public shell —
   never /api — so financial data is never written to browser storage.
   Requires HTTPS (or localhost); it's a no-op elsewhere. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed:", e.message));
  });
}
