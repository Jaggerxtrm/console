export type ExplorePanelKind = "agentops" | "forensic" | "prom";

export interface ExplorePanelBase {
  id: string;
  kind: ExplorePanelKind;
  title: string;
}

export interface ExploreNativeMount extends ExplorePanelBase {
  mount: "native";
  kind: ExplorePanelKind;
  component: "agentops-explorer" | "coming-soon" | "forensic-explorer" | "promql-explorer";
}

export type ExploreMountResult = ExploreNativeMount;

export interface Datasource {
  id: string;
  kind: ExplorePanelKind;
  label: string;
  mount(): ExploreMountResult;
}
