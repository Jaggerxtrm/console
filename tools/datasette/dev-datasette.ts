import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath = process.env.XTRM_MATERIALIZED_DB;
if (!dbPath) {
  console.error("XTRM_MATERIALIZED_DB is required");
  process.exit(1);
}

const metadata = resolve("tools/datasette/metadata.yml");
const logPath = resolve(process.env.DATASETTE_LOG ?? "logs/datasette.log");
const mountPath = resolve(".tmp-datasette/xtrm.db");
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(mountPath), { recursive: true });
if (existsSync(mountPath)) unlinkSync(mountPath);
symlinkSync(resolve(dbPath), mountPath);

const args = [
  "serve",
  "--host",
  "127.0.0.1",
  "--port",
  "8001",
  "--metadata",
  metadata,
  mountPath,
  "--setting",
  "base_url",
  "/explore/sql/",
];

console.log(`[datasette] datasette ${args.join(" ")}`);
const logStream = createWriteStream(logPath, { flags: "a" });
const child = spawn("datasette", args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);
child.on("exit", (code, signal) => {
  logStream.end();
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
