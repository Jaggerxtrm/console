import { useEffect, useRef } from "react";
import { logClientEvent } from "../lib/client-log.ts";
import { useShellStore } from "../stores/shell.ts";

export function useDocumentTitle(): void {
  const title = useShellStore((state) => {
    const selectedRepo = state.selection.repo;
    if (!selectedRepo) return "console";
    const repo = state.repos.find((candidate) => candidate.fullName === selectedRepo);
    return `${repo?.displayName ?? selectedRepo.split("/").pop() ?? selectedRepo} · console`;
  });
  const previous = useRef(typeof document !== "undefined" ? document.title : "console");

  useEffect(() => {
    if (typeof document === "undefined") return;
    const from = previous.current;
    if (document.title !== title) document.title = title;
    if (from !== title) {
      logClientEvent("documentTitle.changed", { from, to: title, source: title === "console" ? "default" : "project_select" });
      previous.current = title;
    }
  }, [title]);
}
