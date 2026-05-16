// TopBar (forge-7xu). Surface switch [GitHub | Beads] on the left,
// tab strip on the right.

import { MarkGithubIcon, ProjectIcon } from "@primer/octicons-react";
import {
  useShellStore,
  selectSelection,
} from "../../stores/shell.ts";
import {
  BEADS_TABS,
  GITHUB_TABS,
  type Surface,
  type TabId,
} from "../../../types/shell.ts";

export function TopBar() {
  const selection = useShellStore(selectSelection);
  const setSurface = useShellStore((s) => s.setSurface);
  const setTab = useShellStore((s) => s.setTab);

  const tabs = selection.surface === "github" ? GITHUB_TABS : BEADS_TABS;

  return (
    <header className="ide-topbar" role="banner">
      <div className="ide-topbar-switch" role="tablist" aria-label="Surface">
        <SurfaceButton
          id="github"
          label="GitHub"
          icon={<MarkGithubIcon size={14} />}
          active={selection.surface === "github"}
          onSelect={setSurface}
        />
        <SurfaceButton
          id="beads"
          label="Beads"
          icon={<ProjectIcon size={14} />}
          active={selection.surface === "beads"}
          onSelect={setSurface}
        />
      </div>
      <nav className="ide-topbar-tabs" role="tablist" aria-label={`${selection.surface} tabs`}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selection.tab === t.id}
            className={selection.tab === t.id ? "ide-tab is-active" : "ide-tab"}
            onClick={() => setTab(t.id as TabId)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

function SurfaceButton({
  id,
  label,
  icon,
  active,
  onSelect,
}: {
  id: Surface;
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onSelect: (s: Surface) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "ide-surface-btn is-active" : "ide-surface-btn"}
      onClick={() => onSelect(id)}
    >
      <span className="ide-surface-icon" aria-hidden="true">{icon}</span>
      <span className="ide-surface-label">{label}</span>
    </button>
  );
}
