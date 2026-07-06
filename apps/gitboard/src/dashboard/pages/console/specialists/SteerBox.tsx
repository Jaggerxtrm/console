import { useState, type FormEvent } from "react";

export function SteerBox({ jobId, onSubmit }: { jobId: string; onSubmit: (jobId: string, message: string) => Promise<void> | void }) {
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      setError("Message required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(jobId, trimmed);
      setMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Steer failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="console-specialists-steer-box" onSubmit={handleSubmit}>
      <label className="console-specialists-steer-box-label" htmlFor={`steer-${jobId}`}>Steer</label>
      <textarea
        id={`steer-${jobId}`}
        className="console-specialists-steer-box-input"
        rows={3}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Next instruction"
      />
      <div className="console-specialists-control-row">
        <button type="submit" className="ide-btn" disabled={submitting}>{submitting ? "Sending…" : "Send steer"}</button>
        {error ? <span className="console-specialists-control-error">{error}</span> : null}
      </div>
    </form>
  );
}
