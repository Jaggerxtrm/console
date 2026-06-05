import { describe, expect, it } from "vitest";
import { dependencyColumnMapping } from "../../src/core/dolt-client.ts";

describe("DoltClient dependency schema mapping", () => {
  it("uses current bd dependency columns", () => {
    expect(dependencyColumnMapping(new Set(["issue_id", "depends_on_issue_id", "type"]))).toEqual({
      issueColumn: "issue_id",
      targetColumn: "depends_on_issue_id",
      typeColumn: "type",
    });
  });

  it("keeps older dependency column shapes readable", () => {
    expect(dependencyColumnMapping(new Set(["issue_id", "depends_on_id", "type"]))).toEqual({
      issueColumn: "issue_id",
      targetColumn: "depends_on_id",
      typeColumn: "type",
    });
    expect(dependencyColumnMapping(new Set(["from_issue", "to_issue", "dependency_type"]))).toEqual({
      issueColumn: "from_issue",
      targetColumn: "to_issue",
      typeColumn: "dependency_type",
    });
  });
});
