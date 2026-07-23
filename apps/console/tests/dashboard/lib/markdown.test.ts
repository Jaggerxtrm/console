/** @vitest-environment node */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clientLog from "../../../src/dashboard/lib/client-log.ts";

vi.mock("react/jsx-runtime", () => {
  const makeElement = (type: unknown, props: Record<string, unknown> | null, key: string | null) => ({
    $$typeof: Symbol.for("react.element"),
    type,
    key,
    ref: null,
    props: props ?? {},
    _owner: null,
    _store: {},
  });
  return {
    Fragment: Symbol.for("react.fragment"),
    jsx: (type: unknown, props: Record<string, unknown>, key?: string) => makeElement(type, props, key ?? null),
    jsxs: (type: unknown, props: Record<string, unknown>, key?: string) => makeElement(type, props, key ?? null),
  };
});

const logClientEventSpy = vi.spyOn(clientLog, "logClientEvent");
const { renderPrBodyText } = await import("../../../src/dashboard/lib/markdown.tsx");

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "../../fixtures/sp-results");

function elementType(node: unknown): string | symbol | undefined {
  return typeof node === "object" && node !== null ? (node as { type?: string | symbol }).type : undefined;
}

function elementProps(node: unknown): Record<string, unknown> {
  return typeof node === "object" && node !== null ? ((node as { props?: Record<string, unknown> }).props ?? {}) : {};
}

function childElements(node: unknown): unknown[] {
  const props = elementProps(node);
  const flatten = (children: unknown): unknown[] => {
    if (Array.isArray(children)) return children.flatMap(flatten);
    return typeof children === "object" && children !== null ? [children] : [];
  };
  return flatten(props.children);
}

function descendants(node: unknown): unknown[] {
  return childElements(node).flatMap((child) => [child, ...descendants(child)]);
}

function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("");
  if (typeof value === "object" && value !== null) return flattenText(elementProps(value).children);
  return "";
}

function allDescendants(nodes: unknown[]): unknown[] {
  return nodes.flatMap((node) => [node, ...descendants(node)]);
}

beforeEach(() => {
  logClientEventSpy.mockClear();
});

describe("dashboard markdown renderer corpus", () => {
  const structuralCases: Array<[string, string, string]> = [
    ["h1", "# Heading", "h1"],
    ["h2", "## Heading", "h2"],
    ["h3", "### Heading", "h3"],
    ["h4", "#### Heading", "h4"],
    ["bold", "**bold**", "strong"],
    ["italic", "*italic*", "em"],
    ["inline code", "`code`", "code"],
    ["bare url", "https://example.com", "a"],
    ["markdown http link", "[docs](https://example.com/docs)", "a"],
    ["mailto link", "[mail](mailto:a@example.com)", "a"],
    ["bullet dash", "- item", "ul"],
    ["bullet star", "* item", "ul"],
    ["ordered dot", "1. item", "ol"],
    ["ordered paren", "1) item", "ol"],
    ["fenced code", "```ts\nconst a = 1;\n```", "pre"],
    ["plain fenced code", "```\nraw\n```", "pre"],
    ["tilde fenced code", "~~~json\n{\"a\":1}\n~~~", "pre"],
    ["table", "| A | B |\n| --- | --- |\n| 1 | 2 |", "table"],
    ["blockquote", "> quoted", "blockquote"],
    ["paragraph newline", "one\ntwo", "p"],
    ["json escaped newline", "one\\ntwo", "p"],
  ];

  it.each(structuralCases)("renders %s", (_label, source, expectedType) => {
    const nodes = renderPrBodyText(source);
    expect(allDescendants(nodes).some((node) => elementType(node) === expectedType)).toBe(true);
    expect(logClientEventSpy).toHaveBeenCalledWith("dashboard.markdown.rendered", expect.objectContaining({ contentBytes: expect.any(Number) }));
  });

  it("strips raw html and rejects unsafe protocols", () => {
    const nodes = renderPrBodyText("<script>alert(1)</script><iframe src='x'></iframe>[bad](javascript:alert(1)) [ok](https://safe.example)");
    const serialised = JSON.stringify(nodes);
    const hrefs = allDescendants(nodes).filter((node) => elementType(node) === "a").map((node) => elementProps(node).href);

    expect(serialised).not.toContain("<script");
    expect(serialised).not.toContain("<iframe");
    expect(hrefs).toEqual(["https://safe.example"]);
    expect(logClientEventSpy).toHaveBeenCalledWith("dashboard.markdown.parse.warn", { hint: "raw html stripped" });
  });

  it("emits rejected telemetry for empty rendered content", () => {
    renderPrBodyText("<script>alert(1)</script>");

    expect(logClientEventSpy).toHaveBeenCalledWith("dashboard.markdown.rejected", { reason: "empty", count: 1 });
  });

  it("is whitespace-variant stable and never emits raw script or iframe tags", () => {
    const seeds = ["**bold**", "- item", "1. item", "> quote", "[safe](https://example.com)", "<script>x</script>", "<iframe>x</iframe>"];

    for (let index = 0; index < 1000; index += 1) {
      const seed = seeds[index % seeds.length]!;
      const prefix = " ".repeat(index % 4);
      const suffix = "\n".repeat(index % 3);
      const nodes = renderPrBodyText(`${prefix}${seed}${suffix}`);
      const serialised = JSON.stringify(nodes);
      expect(serialised).not.toContain("<script");
      expect(serialised).not.toContain("<iframe");
    }
  });

  it("captures representative specialist result snapshots", () => {
    const snapshots = ["executor.txt", "reviewer.txt", "code-sanity.txt"].map((name) => {
      const text = readFileSync(resolve(fixturesDir, name), "utf8");
      const nodes = renderPrBodyText(text);
      return {
        name,
        rootTypes: nodes.map((node) => elementType(node)),
        text: nodes.map(flattenText).join("\n"),
      };
    });

    expect(snapshots).toMatchSnapshot();
    expect(logClientEventSpy.mock.calls.filter(([event]) => event === "dashboard.markdown.rendered")).toHaveLength(3);
  });
});
