export const TYPE_CONFIG = {
  bug: { label: "Bug", color: "#ff4d5e" },
  feature: { label: "Feature", color: "#4169e1" },
  task: { label: "Task", color: "var(--text-muted)" },
  epic: { label: "Epic", color: "rgba(163,113,247,0.95)" },
  chore: { label: "Chore", color: "var(--text-muted)" },
} as const;

export type TypeConfigKey = keyof typeof TYPE_CONFIG;
