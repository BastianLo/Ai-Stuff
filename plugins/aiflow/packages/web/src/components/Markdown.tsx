import { Fragment, type ReactNode } from "react";

/** Kleines, sicheres Markdown-Rendering (Überschriften, Listen, Code, fett, inline-Code) ohne HTML-Injektion. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];
  let ordered = false;
  let code: string[] | undefined;
  const flushList = () => {
    if (list.length === 0) return;
    const items = list.map((l, i) => <li key={i}>{inline(l)}</li>);
    blocks.push(ordered ? <ol key={blocks.length} className="ml-5 list-decimal space-y-0.5">{items}</ol> : <ul key={blocks.length} className="ml-5 list-disc space-y-0.5">{items}</ul>);
    list = [];
  };
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (code) {
        blocks.push(<pre key={blocks.length} className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{code.join("\n")}</pre>);
        code = undefined;
      } else {
        flushList();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1]?.length ?? 1;
      const cls = level === 1 ? "text-lg font-semibold" : level === 2 ? "text-base font-semibold mt-2" : "text-sm font-semibold";
      blocks.push(<div key={blocks.length} className={cls}>{inline(heading[2] ?? "")}</div>);
    } else if (bullet || numbered) {
      if (list.length > 0 && ordered !== Boolean(numbered)) flushList();
      ordered = Boolean(numbered);
      list.push((bullet?.[1] ?? numbered?.[1]) ?? "");
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flushList();
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}

function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i}>{p.slice(2, -2)}</strong>
    ) : p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded bg-slate-100 px-1 font-mono text-[0.85em] dark:bg-slate-800">
        {p.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}
