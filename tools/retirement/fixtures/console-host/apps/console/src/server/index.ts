import { createRuntimeHost } from "@xtrm/core/runtime";

const host = createRuntimeHost({
  owner: "apps/console",
  port: Number(process.env.PORT ?? 3000),
});

host.start();
