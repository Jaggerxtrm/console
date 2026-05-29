import { isAbsolute, relative, resolve } from "node:path";

export function isInsidePath(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function safeJoin(root: string, unsafePath: string): string | null {
  const target = resolve(root, unsafePath);
  return isInsidePath(root, target) ? target : null;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
