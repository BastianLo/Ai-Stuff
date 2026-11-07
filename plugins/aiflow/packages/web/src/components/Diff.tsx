import type { FileChange } from "@aiflow/core";
import { cx } from "./ui";

/** Unified-Diff mit Zeilennummern und Farbe. */
export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  let oldNo = 0;
  let newNo = 0;
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950">
      {lines.map((line, i) => {
        if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("new file") || line.startsWith("deleted file")) return null;
        if (line.startsWith("@@")) {
          const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
          oldNo = Number(m?.[1] ?? 0);
          newNo = Number(m?.[2] ?? 0);
          return (
            <div key={i} className="diff-line bg-sky-50 px-3 text-sky-700 dark:bg-sky-950 dark:text-sky-300">
              {line}
            </div>
          );
        }
        const add = line.startsWith("+");
        const del = line.startsWith("-");
        const o = add ? "" : String(oldNo++);
        const n = del ? "" : String(newNo++);
        return (
          <div key={i} className={cx("diff-line flex", add && "bg-emerald-50 dark:bg-emerald-950/60", del && "bg-rose-50 dark:bg-rose-950/60")}>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-slate-400">{o}</span>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-slate-400">{n}</span>
            <span className={cx("pr-4", add && "text-emerald-800 dark:text-emerald-200", del && "text-rose-800 dark:text-rose-200")}>{line || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

export function FileStatusIcon({ status }: { status: FileChange["status"] }) {
  const map = { added: ["A", "text-emerald-600"], modified: ["M", "text-amber-600"], deleted: ["D", "text-rose-600"], renamed: ["R", "text-sky-600"] } as const;
  const [letter, color] = map[status];
  return <span className={cx("w-4 font-mono text-xs font-bold", color)}>{letter}</span>;
}
