import { useState, type ReactNode } from "react";

export type BeadFieldEditorProps<T> = {
  id: string;
  value: T;
  onChange: (value: T) => Promise<void> | void;
};

const STATUSES = ["open", "in_progress", "blocked", "in_review", "deferred", "closed"];
const TYPES = ["task", "feature", "bug", "epic", "chore"];
const PRIORITIES = [0, 1, 2, 3, 4];

export function BeadTitleEditor({ id, value, onChange }: BeadFieldEditorProps<string>) {
  return <TextEditor id={id} value={value} label="Title" required onChange={(next) => onChange(next ?? "")} />;
}

export function BeadDescriptionEditor(props: BeadFieldEditorProps<string | null>) {
  return <TextAreaEditor {...props} label="Description" />;
}

export function BeadPriorityEditor(props: BeadFieldEditorProps<number>) {
  return <SelectEditor {...props} label="Priority" options={PRIORITIES.map((value) => ({ label: `P${value}`, value: String(value) }))} parse={(value) => Number(value)} />;
}

export function BeadStatusEditor(props: BeadFieldEditorProps<string>) {
  return <SelectEditor {...props} label="Status" options={STATUSES.map((value) => ({ label: value, value }))} parse={(value) => value} />;
}

export function BeadTypeEditor(props: BeadFieldEditorProps<string>) {
  return <SelectEditor {...props} label="Type" options={TYPES.map((value) => ({ label: value, value }))} parse={(value) => value} />;
}

export function BeadAssigneeEditor(props: BeadFieldEditorProps<string | null>) {
  return <TextEditor {...props} label="Assignee" />;
}

export function BeadLabelsEditor({ id, value, onChange }: BeadFieldEditorProps<string[]>) {
  return <TextEditor id={id} label="Labels" value={value.join(", ")} onChange={(next) => onChange((next ?? "").split(",").map((label) => label.trim()).filter(Boolean))} />;
}

export function DeleteBeadButton({ id, onDelete }: { id: string; onDelete: () => Promise<void> | void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!confirming) { setConfirming(true); return; }
    setBusy(true); setError(null);
    try { await onDelete(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="bead-inline-edit-row bead-inline-edit-danger"><button type="button" onClick={submit} disabled={busy}>{confirming ? `Confirm delete ${id}` : "Delete bead"}</button>{confirming ? <button type="button" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button> : null}{error ? <span>{error}</span> : null}</div>;
}

export function NewIssueComposer({ onCreate }: { onCreate: (input: { title: string; description?: string | null; priority?: number; type?: string; labels?: string[] }) => Promise<void> | void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(2);
  const [type, setType] = useState("task");
  const [labels, setLabels] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!title.trim()) return;
    setBusy(true); setError(null);
    try {
      await onCreate({ title: title.trim(), description: description.trim() || null, priority, type, labels: labels.split(",").map((label) => label.trim()).filter(Boolean) });
      setTitle(""); setDescription(""); setPriority(2); setType("task"); setLabels("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="bead-new-issue-composer"><input aria-label="New issue title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New issue title" /><textarea aria-label="New issue description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" /><div><select aria-label="New issue priority" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>{PRIORITIES.map((value) => <option key={value} value={value}>P{value}</option>)}</select><select aria-label="New issue type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((value) => <option key={value} value={value}>{value}</option>)}</select><input aria-label="New issue labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="labels" /><button type="button" disabled={busy || !title.trim()} onClick={() => void submit()}>Create issue</button></div>{error ? <p>{error}</p> : null}</section>;
}

function TextEditor({ id, label, value, onChange, required = false }: BeadFieldEditorProps<string | null> & { label: string; required?: boolean }) {
  const [draft, setDraft] = useState(value ?? "");
  return <FieldShell label={label} onSave={() => onChange(draft || null)} disabled={required && !draft.trim()}><input aria-label={`${label} for ${id}`} value={draft} onChange={(e) => setDraft(e.target.value)} /></FieldShell>;
}

function TextAreaEditor({ id, label, value, onChange }: BeadFieldEditorProps<string | null> & { label: string }) {
  const [draft, setDraft] = useState(value ?? "");
  return <FieldShell label={label} onSave={() => onChange(draft || null)}><textarea aria-label={`${label} for ${id}`} value={draft} onChange={(e) => setDraft(e.target.value)} /></FieldShell>;
}

function SelectEditor<T>({ id, label, value, onChange, options, parse }: BeadFieldEditorProps<T> & { label: string; options: Array<{ label: string; value: string }>; parse: (value: string) => T }) {
  return <label className="bead-inline-edit-row"><span>{label}</span><select aria-label={`${label} for ${id}`} value={String(value)} onChange={(e) => void onChange(parse(e.target.value))}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}

function FieldShell({ label, children, disabled = false, onSave }: { label: string; children: ReactNode; disabled?: boolean; onSave: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true); setError(null);
    try { await onSave(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <label className="bead-inline-edit-row"><span>{label}</span>{children}<button type="button" disabled={busy || disabled} onClick={() => void submit()}>Save</button>{error ? <small>{error}</small> : null}</label>;
}
