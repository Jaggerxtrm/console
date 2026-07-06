import { useState } from "react";
import { resumeJob, steerJob, stopJob, type UpdatedJob } from "../../../hooks/specialists-control.ts";
import { logClientEvent } from "../../../lib/client-log.ts";
import { SteerBox } from "./SteerBox.tsx";

type ControlAction = "stop" | "steer" | "resume";

export function ChainControls({ chainId, jobId, status, onAction }: { chainId: string; jobId: string; status: string; onAction?: (job: UpdatedJob, action: ControlAction) => void }) {
  const [showSteer, setShowSteer] = useState(false);
  const [busyAction, setBusyAction] = useState<ControlAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canResume = status === "waiting";

  async function runAction(action: ControlAction, task?: string) {
    setBusyAction(action);
    setError(null);
    try {
      const updatedJob = action === "stop"
        ? await stopJob(jobId)
        : action === "resume"
          ? await resumeJob(jobId, task ?? "")
          : await steerJob(jobId, task ?? "");
      logClientEvent(`specialist.${action}`, { chainId, jobId, statusBefore: status, statusAfter: updatedJob.status });
      onAction?.(updatedJob, action);
      if (action === "steer") setShowSteer(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${action} failed`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="console-specialists-chain-controls">
      <div className="console-specialists-control-row">
        <button
          type="button"
          className="ide-btn danger"
          disabled={busyAction !== null}
          onClick={() => {
            if (!window.confirm(`Stop specialist job ${jobId}?`)) return;
            void runAction("stop");
          }}
        >
          {busyAction === "stop" ? "Stopping…" : "Stop"}
        </button>
        {canResume ? (
          <button
            type="button"
            className="ide-btn"
            disabled={busyAction !== null}
            onClick={() => {
              const task = window.prompt(`Resume task for ${jobId}`, "");
              if (!task?.trim()) return;
              void runAction("resume", task.trim());
            }}
          >
            {busyAction === "resume" ? "Resuming…" : "Resume"}
          </button>
        ) : null}
        <button type="button" className="ide-btn" disabled={busyAction !== null} onClick={() => setShowSteer((value) => !value)}>
          {showSteer ? "Hide steer" : "Steer"}
        </button>
      </div>
      {showSteer ? <SteerBox jobId={jobId} onSubmit={(_nextJobId, message) => runAction("steer", message)} /> : null}
      {error ? <div className="console-specialists-control-error" role="status">{error}</div> : null}
    </div>
  );
}
