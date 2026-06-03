import type { ReactNode } from "react";
import { logClientEvent } from "./client-log.ts";

const HREF_PROTOCOL_RE = /^(https?:|mailto:)/i;
const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\((?:https?:\/\/|mailto:|forge-)[^\s)]+\))|(https?:\/\/[^\s<]+)|((?:https?:\/\/|mailto:)[^\s<]+)/g;

type Telemetry = {
  contentBytes: number;
  fenceCount: number;
  tableCount: number;
  headingMax: number;
  durationMs: number;
};

function sanitize(raw: string): { text: string; htmlStripped: boolean } {
  const htmlStripped = /<[^>]+>/.test(raw) || /<script\b|<style\b/i.test(raw);
  const text = raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "    ")
    .replace(/\r\n/g, "\n");
  return { text, htmlStripped };
}

function isSafeHref(href: string): boolean {
  return HREF_PROTOCOL_RE.test(href);
}

function renderInline(text: string, key: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let count = 0;

  for (const match of text.matchAll(INLINE_RE)) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    count += 1;
    const token = match[0];
    if (match[1]) parts.push(<code key={`${key}-code-${count}`}>{token.slice(1, -1)}</code>);
    else if (match[2]) parts.push(<strong key={`${key}-strong-${count}`}>{token.slice(2, -2)}</strong>);
    else if (match[3]) parts.push(<em key={`${key}-em-${count}`}>{token.slice(1, -1)}</em>);
    else if (match[4]) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch && isSafeHref(linkMatch[2])) {
        parts.push(<a key={`${key}-link-${count}`} href={linkMatch[2]} target="_blank" rel="noreferrer">{linkMatch[1]}</a>);
      } else {
        parts.push(linkMatch?.[1] ?? token);
      }
    } else if (match[5]) {
      parts.push(<a key={`${key}-url-${count}`} href={token} target="_blank" rel="noreferrer">{token}</a>);
    } else if (match[6] && isSafeHref(token)) {
      parts.push(<a key={`${key}-bare-${count}`} href={token} target="_blank" rel="noreferrer">{token}</a>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function parseTableCells(row: string): string[] {
  return row.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableSeparator(row: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(row);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function renderMarkdownNodes(text: string): ReactNode[] {
  const startedAt = Date.now();
  const { text: sanitised, htmlStripped } = sanitize(text);
  const lines = sanitised.split("\n");
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: ReactNode[] = [];
  let listKind: "ul" | "ol" | null = null;
  let fenceCount = 0;
  let tableCount = 0;
  let headingMax = 0;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    nodes.push(<p key={`p-${nodes.length}`}>{paragraph.map((line, index) => <span key={index}>{renderInline(line, `p-${nodes.length}-${index}`)}{index < paragraph.length - 1 ? <br /> : null}</span>)}</p>);
    paragraph = [];
  };

  const flushList = (): void => {
    if (listItems.length === 0) return;
    const Tag = listKind ?? "ul";
    nodes.push(<Tag key={`${Tag}-${nodes.length}`}>{listItems}</Tag>);
    listItems = [];
    listKind = null;
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = /^(```|~~~)\s*([\w-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushParagraph();
      flushList();
      fenceCount += 1;
      const endFence = new RegExp(`^${fence[1]}\\s*$`);
      const code: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (endFence.test(lines[i].trim())) { closed = true; break; }
        code.push(lines[i]);
        i += 1;
      }
      if (closed) i += 1;
      else logClientEvent("dashboard.markdown.parse.warn", { hint: "unclosed fence" });
      nodes.push(<pre key={`pre-${nodes.length}`} data-lang={fence[2] || undefined}><code>{code.join("\n")}</code></pre>);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      headingMax = Math.max(headingMax, heading[1].length);
      const level = heading[1].length;
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      nodes.push(<Tag key={`h-${nodes.length}`}>{renderInline(heading[2], `h-${nodes.length}`)}</Tag>);
      i += 1;
      continue;
    }

    const list = /^([-*]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (list) {
      flushParagraph();
      const nextKind = /^\d/.test(list[1]) ? "ol" : "ul";
      if (listKind && listKind !== nextKind) flushList();
      listKind = nextKind;
      listItems.push(<li key={`li-${nodes.length}-${listItems.length}`}>{renderInline(list[2], `li-${nodes.length}-${listItems.length}`)}</li>);
      i += 1;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      flushList();
      nodes.push(<blockquote key={`bq-${nodes.length}`}>{renderInline(quote[1], `bq-${nodes.length}`)}</blockquote>);
      i += 1;
      continue;
    }

    if (/^\|.*\|$/.test(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      flushParagraph();
      flushList();
      tableCount += 1;
      const headers = parseTableCells(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        rows.push(parseTableCells(lines[i].trim()));
        i += 1;
      }
      nodes.push(
        <table key={`tbl-${nodes.length}`} className="rich-table">
          <thead><tr>{headers.map((header, index) => <th key={index}>{renderInline(header, `th-${nodes.length}-${index}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell, `td-${nodes.length}-${rowIndex}-${cellIndex}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  flushList();
  if (htmlStripped) logClientEvent("dashboard.markdown.parse.warn", { hint: "raw html stripped" });
  if (nodes.length === 0) logClientEvent("dashboard.markdown.rejected", { reason: "empty", count: 1 });
  logClientEvent("dashboard.markdown.rendered", { contentBytes: byteLength(text), fenceCount, tableCount, headingMax, durationMs: Date.now() - startedAt });
  return nodes;
}

export function ResultMarkdown({ text }: { text: string }) {
  const rendered = renderMarkdownNodes(text);
  return <div className="pr-rich-text">{rendered}</div>;
}

export function renderPrBodyText(value: string): ReactNode[] {
  return renderMarkdownNodes(value);
}
