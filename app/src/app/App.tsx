import { useEffect, useState } from "react";
import { HashRouter, Outlet, Route, Routes } from "react-router-dom";
import { CommandSearch } from "@/components/CommandSearch";
import { TopBar } from "@/components/TopBar";
import { initAppStore } from "@/lib/store";
import { Home } from "@/pages/Home";
import { SettingsPage } from "@/pages/Settings";
import { ToolPage } from "@/pages/Tool";

function Layout() {
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
