export interface ShellProviderPolicy {
  enabled: boolean;
  allowRemote: boolean;
  allowAdminOnly: boolean;
  devGateRequired: boolean;
  cwdAllowlist: string[];
  shellAllowlist: string[];
  envScrub: string[];
  maxSessions: number;
  idleTimeoutMs: number;
  hardTtlMs: number;
  maxInputBytesPerSecond: number;
  maxOutputBytesPerSecond: number;
  auditEnabled: boolean;
  orphanCleanupEnabled: boolean;
}

export interface ShellProviderStatus {
  enabled: boolean;
  disabledReason: string;
  policy: ShellProviderPolicy;
}
