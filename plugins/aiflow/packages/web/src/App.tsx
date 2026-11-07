import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { ApiError } from "@aiflow/client";
import { Layout } from "./components/Layout";
import { api } from "./lib/api";
import { Dashboard } from "./pages/Dashboard";
import { InboxPage } from "./pages/Inbox";
import { AgentsPage } from "./pages/Agents";
import { AgentEditor } from "./pages/AgentEditor";
import { SnippetsPage } from "./pages/Snippets";
import { WorkflowsPage } from "./pages/Workflows";
import { WorkflowEditor } from "./pages/WorkflowEditor";
import { RunsPage } from "./pages/Runs";
import { RunView } from "./pages/RunView";
import { ReviewPage } from "./pages/Review";
import { SettingsPage } from "./pages/Settings";

function LoginRequired() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <img src="/favicon.svg" alt="" className="mx-auto mb-3 h-10 w-10" />
        <h1 className="text-lg font-semibold">Anmeldung erforderlich</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Öffne die Web-UI über <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">/aiflow-configure</code> in opencode oder mit{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">aiflow open</code> im Terminal. Der Link meldet dich einmalig an.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health(), retry: false });
  if (health.error instanceof ApiError && health.error.status === 401) return <LoginRequired />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:id" element={<AgentEditor />} />
        <Route path="/snippets" element={<SnippetsPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowEditor />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunView />} />
        <Route path="/runs/:id/review" element={<ReviewPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </Layout>
  );
}
