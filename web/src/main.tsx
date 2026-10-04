import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { DemoControls } from './demo/DemoControls';

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* device drafts work without a service worker */
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DemoControls />
    <App />
  </React.StrictMode>,
);
