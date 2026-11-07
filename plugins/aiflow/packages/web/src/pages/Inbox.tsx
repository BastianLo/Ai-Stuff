import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { InboxItem } from "@aiflow/core";
import { api, useProject } from "../lib/api";
import { relative } from "../lib/format";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Textarea } from "../components/ui";

function Item({ item }: { item: InboxItem }) {
  const [project] = useProject();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const answer = useMutation({
    mutationFn: (option: string) => api.answer(item.runId, item.id, option, text || undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });
  const q = project ? `?project=${encodeURIComponent(project)}` : "";
  return (
    <Card>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Badge color={item.kind === "review" ? "violet" : item.kind === "human" ? "amber" : "sky"}>{item.kind === "review" ? "Review" : item.kind === "human" ? "Freigabe" : "Rückfrage"}</Badge>
          <span className="text-sm font-semibold">{item.title}</span>
          <span className="ml-auto text-xs text-slate-500">{relative(item.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{item.question}</p>
        {item.kind === "review" ? (
          <Link to={`/runs/${item.runId}/review${q}`}>
            <Button variant="primary">Review öffnen</Button>
          </Link>
        ) : (
          <>
            {item.allowFreeText && <Textarea rows={2} placeholder="Anmerkung (optional, geht als Übergabe an den nächsten Schritt)" value={text} onChange={(e) => setText(e.target.value)} />}
            <div className="flex flex-wrap gap-2">
              {item.options.map((o, i) => (
                <Button key={o} variant={i === 0 ? "primary" : "secondary"} disabled={answer.isPending} onClick={() => answer.mutate(o)}>
                  {o}
                </Button>
              ))}
              <Link to={`/runs/${item.runId}${q}`} className="ml-auto self-center text-xs text-indigo-600">
                Run ansehen
              </Link>
            </div>
            <ErrorBox error={answer.error} />
          </>
        )}
      </div>
    </Card>
  );
}

export function InboxPage() {
  const [project] = useProject();
  const inbox = useQuery({ queryKey: ["inbox", project], queryFn: () => api.inbox(project) });
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Inbox" subtitle="Freigaben, Rückfragen von Agenten und ausstehende Reviews." />
      <div className="space-y-3">
        {(inbox.data ?? []).length === 0 ? <Card><Empty title="Alles erledigt">Hier erscheint, was auf dich wartet.</Empty></Card> : inbox.data?.map((i) => <Item key={i.id} item={i} />)}
      </div>
    </div>
  );
}
