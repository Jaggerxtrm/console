import { DotFillIcon } from "@primer/octicons-react";
import type { RepoNode } from "../../../types/shell.ts";

export function Graph({ repo }: { repo: RepoNode | null }) {
  return (
    <div className="ide-empty ide-console-placeholder">
      <p className="ide-empty-msg">
        <DotFillIcon size={10} /> Coming in forge-f6qk.3{repo ? ` for ${repo.displayName}` : ""}
      </p>
    </div>
  );
}
