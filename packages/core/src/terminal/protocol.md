# Terminal stream protocol

Generic envelope:

- `version`: protocol version string
- `kind`: `open | attach | detach | input | output | resize | exit | error | status | heartbeat`
- `streamId`: stream identity
- `sessionId`: session identity
- `timestamp`: ISO timestamp
- `payload`: terminal-specific payload

Provider kinds:

- `pty`
- `tmux`
- `ssh`
- `command`
- `specialist-feed`

Capabilities:

- `readonly`
- `interactive`
- `resizable`
- `snapshot`
- `persistent`

Backpressure note:

- `output.payload.bytes` and `status.payload.backlogBytes` model byte volume.
- UI or transport can pause when backlog grows instead of buffering unbounded output.

Examples:

```ts
createTerminalStreamEnvelope("open", "stream-1", "session-1", {
  providerKind: "pty",
  capabilities: ["interactive", "resizable"],
});

createTerminalStreamEnvelope("output", "stream-1", "session-1", {
  data: "Zm9v",
  encoding: "base64",
  sequence: 42,
  bytes: 3,
});
```
