import { createSpecialistsConfigRouter as createConsoleSpecialistsConfigRouter, type SpecialistsConfigRouterOptions } from "../../../../console/src/server/routes/specialists-config.ts";

export type { SpecialistsConfigRouterOptions } from "../../../../console/src/server/routes/specialists-config.ts";
export { applyFieldEdit, validateGlobalUserConfig, writeGlobalConfigSafe, statConfigFileMtimeMs } from "../../../../console/src/server/routes/specialists-config.ts";

export function createSpecialistsConfigRouter(options: SpecialistsConfigRouterOptions = {}) {
  return createConsoleSpecialistsConfigRouter(options);
}
