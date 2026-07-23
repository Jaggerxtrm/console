import { describe, expect, it } from "vitest";
import { dependencyColumnMapping, doltPoolKey } from "../src/state/dolt-client.ts";

describe("Dolt client compatibility helpers", () => {
  it("maps current and legacy dependency schemas", () => {
    expect(dependencyColumnMapping(new Set(["issue_id", "depends_on_issue_id", "type"]))).toEqual({
      issueColumn: "issue_id",
      targetColumn: "depends_on_issue_id",
      typeColumn: "type",
    });
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

  it("keeps stable pool defaults", () => {
    expect(doltPoolKey({ host: "127.0.0.1", port: 3306 })).toBe("127.0.0.1:3306/dolt/root");
    expect(doltPoolKey({ host: "db", port: 3307, database: "beads", user: "reader" })).toBe("db:3307/beads/reader");
  });
});
