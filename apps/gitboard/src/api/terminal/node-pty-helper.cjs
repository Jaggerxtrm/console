#!/usr/bin/env node
const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

try {
  const pty = require("node-pty");
  const config = JSON.parse(Buffer.from(process.env.GITBOARD_TERMINAL_PTY_CONFIG || "", "base64url").toString("utf8"));
  const term = pty.spawn(config.shell, config.args || [], {
    name: "xterm-256color",
    cols: config.cols || 80,
    rows: config.rows || 24,
    cwd: config.cwd,
    env: config.env || {},
  });

  term.onData((data) => send({ type: "output", data: Buffer.from(data, "utf8").toString("base64") }));
  term.onExit((event) => send({ type: "exit", code: event.exitCode ?? null, signal: event.signal == null ? null : String(event.signal) }));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "input") {
      term.write(Buffer.from(String(msg.data || ""), "base64").toString("utf8"));
      return;
    }
    if (msg.type === "resize") {
      term.resize(Math.max(2, Number(msg.cols) || 80), Math.max(1, Number(msg.rows) || 24));
      return;
    }
    if (msg.type === "dispose") {
      term.kill();
      process.exit(0);
    }
  });
} catch (error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
