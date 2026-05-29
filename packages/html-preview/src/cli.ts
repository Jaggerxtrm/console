#!/usr/bin/env bun
import { resolve } from "node:path";
import { startHtmlPreviewServer } from "./server.ts";
import type { HtmlPreviewOptions } from "./types.ts";

const args = parseArgs(process.argv.slice(2));
const roots = parseRoots(args.root ?? process.env.DOC_PREVIEW_ROOTS ?? process.env.HTML_PREVIEW_ROOTS ?? process.env.HTML_PREVIEW_ROOT);
const resolvedRoots = roots.length > 0 ? roots.map((root) => resolve(root)) : defaultRoots();

const options: HtmlPreviewOptions = {
  root: resolvedRoots[0] ?? process.cwd(),
  roots: resolvedRoots,
  port: Number(args.port ?? process.env.PORT ?? 8787),
  host: args.host ?? process.env.HOST ?? "127.0.0.1",
  maxDepth: Number(args.maxDepth ?? process.env.HTML_PREVIEW_MAX_DEPTH ?? 3),
  maxFiles: Number(args.maxFiles ?? process.env.HTML_PREVIEW_MAX_FILES ?? 50000),
  excludeDirs: parseList(args.excludeDirs ?? process.env.DOC_PREVIEW_EXCLUDE_DIRS ?? process.env.HTML_PREVIEW_EXCLUDE_DIRS),
  excludeSubtrees: parseList(args.excludeSubtrees ?? process.env.DOC_PREVIEW_EXCLUDE_SUBTREES ?? process.env.HTML_PREVIEW_EXCLUDE_SUBTREES),
};

startHtmlPreviewServer(options);

function defaultRoots(): string[] {
  return ["/home/dawid/dev", "/home/dawid/projects"];
}

function parseRoots(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((root) => root.trim()).filter(Boolean);
}

function parseList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    parsed[key] = inlineValue ?? argv[index + 1];
    if (!inlineValue) {
      index += 1;
    }
  }

  return parsed;
}
