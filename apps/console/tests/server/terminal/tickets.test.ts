import { describe, expect, it } from "vitest";
import {
  TERMINAL_TICKET_COOKIE,
  createTerminalTicketRegistry,
} from "../../../src/server/terminal/tickets.ts";

describe("Console terminal tickets", () => {
  it("issues short-lived one-time browser tickets", () => {
    let now = 1000;
    const tickets = createTerminalTicketRegistry({ now: () => now, ttlMs: 5000 });
    const issued = tickets.issue({ isVerifiedAdmin: true });
    const cookie = `${TERMINAL_TICKET_COOKIE}=${issued.ticket}`;

    expect(issued.expiresAt).toBe(6000);
    expect(tickets.consume(cookie)).toEqual({ isVerifiedAdmin: true });
    expect(tickets.consume(cookie)).toBeUndefined();

    const expired = tickets.issue({ isVerifiedAdmin: false });
    now = expired.expiresAt + 1;
    expect(tickets.consume(`${TERMINAL_TICKET_COOKIE}=${expired.ticket}`)).toBeUndefined();
  });

  it("ignores malformed and unrelated cookies", () => {
    const tickets = createTerminalTicketRegistry();

    expect(tickets.consume(null)).toBeUndefined();
    expect(tickets.consume("other=value")).toBeUndefined();
    expect(tickets.consume(`${TERMINAL_TICKET_COOKIE}=not-a-ticket`)).toBeUndefined();
  });
});
