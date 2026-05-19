// TopBar (forge-7xu). Surface switch [GitHub | Beads] on the left,
// tab strip on the right.

import { GraphIcon, MarkGithubIcon, MoonIcon, ProjectIcon, SunIcon } from "@primer/octicons-react";
import {
  useShellStore,
  selectSelection,
  selectTheme,
} from "../../stores/shell.ts";
import {
  BEADS_TABS,
  CONSOLE_TABS,
  GITHUB_TABS,
  type Surface,
  type TabId,
} from "../../../types/shell.ts";

export function TopBar() {
  const selection = useShellStore(selectSelection);
  const theme = useShellStore(selectTheme);
  const setSurface = useShellStore((s) => s.setSurface);
  const setTab = useShellStore((s) => s.setTab);
  const toggleTheme = useShellStore((s) => s.toggleTheme);

  const tabs = selection.surface === "github" ? GITHUB_TABS : selection.surface === "beads" ? BEADS_TABS : CONSOLE_TABS;

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
        <SurfaceButton
          id="console"
          label="Console"
          icon={<GraphIcon size={14} />}
          active={selection.surface === "console"}
          onSelect={setSurface}
        />
      </div>
      <nav className="ide-topbar-tabs" role="tablist" aria-label={`${selection.surface} tabs`}>
        {selection.surface === "console" ? CONSOLE_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selection.tab === t.id}
            aria-disabled={t.id === "specialists" ? true : undefined}
            title={t.id === "specialists" ? "Coming soon — forge-e23" : undefined}
            className={selection.tab === t.id ? "ide-tab is-active" : t.id === "specialists" ? "ide-tab is-disabled" : "ide-tab"}
            onClick={t.id === "specialists" ? undefined : () => setTab(t.id as TabId)}
            disabled={t.id === "specialists"}
          >
            {t.label}
          </button>
        )) : tabs.map((t) => (
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
      <button
        type="button"
        className="ide-theme-toggle"
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        onClick={toggleTheme}
      >
        <span className="ide-theme-track" aria-hidden="true">
          <span className="ide-theme-option ide-theme-option-light">
            <SunIcon size={12} />
          </span>
          <span className="ide-theme-option ide-theme-option-dark">
            <MoonIcon size={12} />
          </span>
          <span className="ide-theme-thumb" />
        </span>
      </button>
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
