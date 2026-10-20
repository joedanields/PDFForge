import { useEffect, useState } from "react";
import { HashRouter, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { CommandSearch } from "@/components/CommandSearch";
import { TopBar } from "@/components/TopBar";
import { api, isTauri, onOpenFiles } from "@/engine/client";
import { initAppStore } from "@/lib/store";
import { Home } from "@/pages/Home";
import { SettingsPage } from "@/pages/Settings";
import { ToolPage } from "@/pages/Tool";
import { chooseAndView, viewerPath } from "@/lib/viewer";
import { ViewerPage } from "@/pages/Viewer";
import { WorkflowEditorPage } from "@/pages/WorkflowEditor";
import { WorkflowRunPage } from "@/pages/WorkflowRun";

function Layout() {
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
      } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void chooseAndView(navigate);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // "Open with PDFForge": files the app was started with, and files from later launches.
  useEffect(() => {
    if (!isTauri()) return;
    const open = (files: string[]) => {
      if (files[0]) navigate(viewerPath(files[0]));
    };
    void api.takeOpenRequests().then(open);
    const unlisten = onOpenFiles(open);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [navigate]);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar onSearch={() => setSearchOpen(true)} />
      <main className="flex-1">
        <Outlet />
      </main>
      <CommandSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

export function App() {
  useEffect(() => {
    initAppStore().catch((err: unknown) => {
      console.error("Failed to initialise app state", err);
    });
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="tool/:toolId" element={<ToolPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="view" element={<ViewerPage />} />
          <Route path="workflows/:workflowId" element={<WorkflowEditorPage />} />
          <Route path="workflows/:workflowId/run" element={<WorkflowRunPage />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
