import * as React from "react";
import { Sidebar, MobileTabbar } from "./Sidebar";

// The macOS-style app frame: draggable titlebar, sidebar, scrollable main.
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="app">
        <header className="titlebar">
          <div className="traffic">
            <i className="r" />
            <i className="y" />
            <i className="g" />
          </div>
          <div className="doc-title">CFA Translate Studio</div>
          <div className="win-meta">EN → Tiếng Việt</div>
        </header>
        <Sidebar />
        <main className="main">{children}</main>
      </div>
      <MobileTabbar />
    </>
  );
}
