import { emit } from "../../core/logger.ts";
import {
  createInternalVerifyRouter as createConsoleInternalVerifyRouter,
  type InternalVerifyRouterOptions,
} from "../../../../console/src/server/routes/internal-verify.ts";

export type { InternalVerifyRouterOptions };

export function createInternalVerifyRouter(options: InternalVerifyRouterOptions = {}) {
  return createConsoleInternalVerifyRouter({ ...options, emit: options.emit ?? emit });
}
