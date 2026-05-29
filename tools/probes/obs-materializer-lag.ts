import { Database } from "bun:sqlite";

const OBS = "/home/dawid/dev/gitboard/.specialists/db/observability.db";
const XTRM = "/home/dawid/.agent-forge/xtrm.sqlite";
const API = "http://100.113.49.52:3030/api/specialists/jobs/in-flight";
const t0 = Date.now();

const proc = Bun.spawn(["sp", "run", "explorer", "--bead", "forge-b31g", "--background", "--keep-alive"], { stdout: "pipe", stderr: "pipe" });
await proc.exited;
const tReturn = Date.now();
const stdoutText = await new Response(proc.stdout).text();
const jobId = stdoutText.trim().split("\n").pop() || "?";
console.log(JSON.stringify({ phase: "sp.return", delta_ms: tReturn - t0, jobId }));

let tObs: number | null = null;
let tXtrm: number | null = null;
let tApi: number | null = null;
const deadline = tReturn + 60000;

while (Date.now() < deadline) {
  const now = Date.now();
  if (tObs === null) { try { const d = new Database(OBS, { readonly: true }); const r = d.query("SELECT 1 FROM specialist_jobs WHERE job_id = ?").get(jobId); d.close(); if (r) { tObs = now; console.log(JSON.stringify({ phase: "obs.row", t_after_return_ms: now - tReturn })); } } catch {} }
  if (tXtrm === null) { try { const d = new Database(XTRM, { readonly: true }); const r = d.query("SELECT 1 FROM specialist_jobs WHERE job_id = ?").get(jobId); d.close(); if (r) { tXtrm = now; console.log(JSON.stringify({ phase: "xtrm.row", t_after_return_ms: now - tReturn, after_obs_ms: tObs !== null ? now - tObs : null })); } } catch {} }
  if (tApi === null) { try { const res = await fetch(API); const j = await res.json() as { in_flight?: Array<{ jobId?: string }> }; if ((j.in_flight ?? []).some(x => x.jobId === jobId)) { tApi = now; console.log(JSON.stringify({ phase: "api.visible", t_after_return_ms: now - tReturn, after_xtrm_ms: tXtrm !== null ? now - tXtrm : null })); } } catch {} }
  if (tObs !== null && tXtrm !== null && tApi !== null) break;
  await Bun.sleep(150);
}

console.log(JSON.stringify({ phase: "summary", jobId, ms: { sp_to_obs: tObs !== null ? tObs - tReturn : null, obs_to_xtrm: tObs !== null && tXtrm !== null ? tXtrm - tObs : null, xtrm_to_api: tXtrm !== null && tApi !== null ? tApi - tXtrm : null, total: tApi !== null ? tApi - tReturn : null } }));

const stopProc = Bun.spawn(["sp", "stop", jobId], { stdout: "pipe", stderr: "pipe" });
await stopProc.exited;
