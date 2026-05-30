/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "../../../core/logger.ts";

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
    jsxDEV: (type: unknown, props: Record<string, unknown>, key?: string) => makeElement(type, props, key ?? null),
  };
});

vi.mock("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("react.fragment"),
  jsxDEV: (type: unknown, props: Record<string, unknown>, key?: string) => ({
    $$typeof: Symbol.for("react.element"),
    type,
    key: key ?? null,
    ref: null,
    props: props ?? {},
    _owner: null,
    _store: {},
  }),
}));

const emitSpy = vi.spyOn(logger, "emit");
const markdown = await import("../markdown.tsx");
const { renderPrBodyText } = markdown;

function elementType(node: unknown): string | symbol | undefined {
  return typeof node === "object" && node !== null ? (node as { type?: string | symbol }).type : undefined;
}

function elementProps(node: unknown): Record<string, unknown> {
  return typeof node === "object" && node !== null ? ((node as { props?: Record<string, unknown> }).props ?? {}) : {};
}

function childElements(node: unknown): unknown[] {
  const props = elementProps(node);
  return Array.isArray(props.children) ? props.children.filter((child): child is object => typeof child === "object" && child !== null) : (typeof props.children === "object" && props.children !== null ? [props.children] : []);
}

function descendants(node: unknown): unknown[] {
  return childElements(node).flatMap((child) => [child, ...descendants(child)]);
}

beforeEach(() => {
  emitSpy.mockClear();
});

afterEach(() => {
  emitSpy.mockClear();
});

describe("ResultMarkdown", () => {
  it("renders representative PR body and strips raw html", () => {
    const nodes = renderPrBodyText([
      "# Heading",
      "Bold **text** with *italic*, `inline code`, and https://example.com",
      "- item 1",
      "- item 2",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "<script>alert(1)</script>",
      "<style>body{}</style>",
      "<div>raw</div>",
    ].join("\n"));

    expect(nodes).toHaveLength(5);
    expect(elementType(nodes[0])).toBe("h1");
    expect(elementType(nodes[1])).toBe("p");
    expect(elementType(nodes[2])).toBe("ul");
    expect(elementType(nodes[3])).toBe("pre");
    expect(elementType(nodes[4])).toBe("p");
    const paragraphJson = JSON.stringify(nodes[1]);
    expect(paragraphJson).toContain('"type":"a"');
    expect(paragraphJson).toContain('"type":"strong"');
    expect(paragraphJson).toContain('"type":"em"');
    expect(paragraphJson).toContain('"type":"code"');
    expect(JSON.stringify(nodes[3])).toContain("const value = 1;");
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rendered")).toBe(true);
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rejected")).toBe(false);
  });

  it("renders sp executor summary prose plus fenced json", () => {
    const nodes = renderPrBodyText([
      "Executor summary:",
      "- parsed result",
      "- emitted telemetry",
      "",
      "```json",
      '{"ok":true,"items":[1,2]}',
      "```",
    ].join("\n"));

    expect(nodes.some((node) => elementType(node) === "ul")).toBe(true);
    expect(nodes.some((node) => elementType(node) === "pre")).toBe(true);
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rendered")).toBe(true);
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rejected")).toBe(false);
  });

  it("renders reviewer verdict table and only safe links", () => {
    const nodes = renderPrBodyText([
      "## Requirement Coverage Matrix",
      "| Requirement | Status | Evidence |",
      "| --- | --- | --- |",
      "| tables | done | https://example.org |",
      "| mailto | done | mailto:team@example.org |",
      "| bad | done | javascript:alert(1) |",
    ].join("\n"));

    const table = nodes.find((node) => elementType(node) === "table");
    expect(table).toBeTruthy();
    expect(childElements(table).some((section) => elementType(section) === "thead")).toBe(true);
    expect(childElements(table).some((section) => elementType(section) === "tbody")).toBe(true);
    const links = descendants(table).filter((child) => elementType(child) === "a").map((child) => elementProps(child).href as string);
    expect(links).toEqual(["https://example.org", "mailto:team@example.org"]);
    expect(descendants(table).some((child) => elementType(child) === "a" && String(elementProps(child).href).startsWith("javascript:"))).toBe(false);
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rejected")).toBe(false);
  });

  it("renders code-sanity findings corpus and keeps inline code", () => {
    const nodes = renderPrBodyText([
      "Findings:",
      "- fix `renderPrBodyText`",
      "- remove `unsafe-html`",
    ].join("\n"));

    expect(nodes.some((node) => elementType(node) === "ul")).toBe(true);
    expect(String(nodes.map((node) => JSON.stringify(node)).join("\n"))).toContain("renderPrBodyText");
    expect(renderPrBodyText("**bold** *italic* https://example.com")).toHaveLength(1);
  });

  it("keeps PR body behavior for originally handled inline cases", () => {
    const nodes = renderPrBodyText("**bold** and *italic* and `code` with https://example.com");
    const paragraph = nodes[0];
    expect(elementType(paragraph)).toBe("p");
    const paragraphJson = JSON.stringify(paragraph);
    expect(paragraphJson).toContain('"type":"strong"');
    expect(paragraphJson).toContain('"type":"em"');
    expect(paragraphJson).toContain('"type":"code"');
    expect(paragraphJson).toContain('"type":"a"');
  });

  it("treats encoded script tags as inert text", () => {
    const nodes = renderPrBodyText("&lt;script&gt;alert(1)&lt;/script&gt;");

    expect(nodes).toHaveLength(1);
    expect(JSON.stringify(nodes[0])).not.toContain('"type":"script"');
    expect(JSON.stringify(nodes[0])).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rejected")).toBe(false);
  });

  it("emits telemetry for raw html stripping", () => {
    renderPrBodyText("<div>unsafe</div>");

    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.parse.warn" && entry.data?.hint === "raw html stripped")).toBe(true);
    expect(emitSpy.mock.calls.some(([entry]) => entry.event === "markdown.rendered" && typeof entry.data?.durationMs === "number")).toBe(true);
  });
});
