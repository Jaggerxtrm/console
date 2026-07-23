export const TERMINAL_TICKET_COOKIE = "xtrm_terminal_ticket";

export interface TerminalTicketAuthContext {
  readonly isVerifiedAdmin: boolean;
}

export interface TerminalTicketRegistry {
  readonly ttlMs: number;
  issue(context: TerminalTicketAuthContext): { ticket: string; expiresAt: number };
  consume(cookieHeader: string | null): TerminalTicketAuthContext | undefined;
}

export interface TerminalTicketRegistryOptions {
  readonly ttlMs?: number;
  readonly maxTickets?: number;
  readonly now?: () => number;
}

type TicketRecord = TerminalTicketAuthContext & { expiresAt: number };

export function createTerminalTicketRegistry(options: TerminalTicketRegistryOptions = {}): TerminalTicketRegistry {
  const ttlMs = options.ttlMs ?? 30_000;
  const maxTickets = options.maxTickets ?? 128;
  const now = options.now ?? (() => Date.now());
  const records = new Map<string, TicketRecord>();

  function prune(timestamp: number): void {
    for (const [ticket, record] of records) {
      if (record.expiresAt <= timestamp) records.delete(ticket);
    }
    while (records.size >= maxTickets) {
      const oldest = records.keys().next().value as string | undefined;
      if (!oldest) break;
      records.delete(oldest);
    }
  }

  return {
    ttlMs,
    issue(context) {
      const timestamp = now();
      prune(timestamp);
      const ticket = crypto.randomUUID();
      const expiresAt = timestamp + ttlMs;
      records.set(ticket, { ...context, expiresAt });
      return { ticket, expiresAt };
    },
    consume(cookieHeader) {
      const ticket = readCookie(cookieHeader, TERMINAL_TICKET_COOKIE);
      if (!ticket) return undefined;
      const record = records.get(ticket);
      records.delete(ticket);
      if (!record || record.expiresAt <= now()) return undefined;
      return { isVerifiedAdmin: record.isVerifiedAdmin };
    },
  };
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
  }
  return undefined;
}
