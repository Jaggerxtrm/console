import { emit, getLogDiskDir, getRing } from "../../core/logger.ts";
import {
  createInternalLogsRouter as createConsoleInternalLogsRouter,
  type InternalLogsRuntime,
} from "../../../../console/src/server/routes/internal-logs.ts";

export type { InternalLogsRuntime };

const runtime: InternalLogsRuntime = { emit, getLogDiskDir, getRing };

export function createInternalLogsRouter() {
  return createConsoleInternalLogsRouter(runtime);
}
