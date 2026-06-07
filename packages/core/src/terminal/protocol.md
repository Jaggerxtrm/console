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

Provider status:

| Kind | Runtime status | Notes |
|---|---|---|
| `pty` | Implemented | Local shell-capable provider behind shell-provider policy gates. |
| `specialist-feed` | Implemented | Readonly job output stream using the same renderer. |
| `tmux` | Reserved | Optional future shell-capable provider for persistent/detachable sessions. It must not be required for local PTY MVP. |
| `ssh` | Reserved | Future remote shell-capable provider for explicitly allowlisted hosts only. No credential storage or remote execution behavior is implied by the protocol. |
| `command` | Reserved | Future bounded command-stream provider. |

Capabilities:

- `readonly`
- `interactive`
- `resizable`
- `snapshot`
- `persistent`

Future `tmux` semantics:

- Use `persistent` only when a session can survive browser reload and backend
  reconnect without pretending that output replay is lossless.
- Keep attach/detach behavior token-bound through the existing `attach`
  payload; do not expose tmux session names directly to the browser.
- Enforce the same cwd/shell allowlists, admin checks, env scrubbing, TTLs,
  idle timeout, and orphan cleanup rules as the PTY provider.
- Treat stale tmux sessions, dead panes, missing sockets, and server restarts as
  recoverable terminal errors until a provider implementation proves stronger
  resume guarantees.

Future `ssh` / Tailscale semantics:

- Represent remote targets as named host profiles, not arbitrary host strings in
  `open.payload`.
- Require explicit host allowlists, operator opt-in, admin-only access, and
  production gates before enabling command input.
- Keep credential material out of protocol payloads, logs, and persisted
  Console state; decide key/agent handling in a dedicated implementation bead.
- Apply the same stream envelope, resize/input/status/error messages, and shell
  policy expectations as local providers so Console remains UI/read/write
  transport, not runtime owner.

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
