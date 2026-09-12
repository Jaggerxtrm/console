import { describe, expect, it } from "vitest";
import { body, flattenData, frontmatterTree } from "../../../src/server/programme/read-model.ts";

describe("programme governed Markdown frontmatter", () => {
  it("parses frontmatter anchored at the beginning of a normal Markdown document", () => {
    const raw = `---\nid: ADR-0099\nstatus: accepted\nnested:\n  decision: OPS-0099\n---\n\n# Synthetic decision\n\nBody.`;
    const tree = frontmatterTree(raw);
    expect(tree.id).toBe("ADR-0099");
    expect(tree.status).toBe("accepted");
    expect(flattenData(tree)["nested.decision"]).toBe("OPS-0099");
  });

  it("removes exactly the leading frontmatter block from body text", () => {
    const raw = `---\nid: TEST\n---\n# Heading\n---\nbody separator`;
    expect(body(raw)).toBe("# Heading\n---\nbody separator");
  });

  it("does not treat a later YAML-looking delimiter as document frontmatter", () => {
    const raw = `# Heading\n\n---\nid: NOT-FRONTMATTER\n---\n`;
    expect(frontmatterTree(raw)).toEqual({});
    expect(body(raw)).toBe(raw);
  });
});
