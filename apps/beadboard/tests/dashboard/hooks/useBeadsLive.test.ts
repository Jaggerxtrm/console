/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBeadsStore } from "../../../src/dashboard/stores/beads.ts";
import { useBeadsLive } from "../../../src/dashboard/hooks/useBeadsLive.ts";

type MockSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  close: () => void;
  send: (data: string) => void;
  triggerOpen: () => void;
  triggerMessage: (data: unknown) => void;
  sent: string[];
};

let socket: MockSocket;
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  useBeadsStore.setState({ issues: [], closedIssues: [], selectedProjectId: null, memories: [], deps: [], kvs: [], sourceHealthByProject: {}, loading: false, error: null, projects: [], selectedIssue: null, agentSessions: [] });
  socket = {
    onopen: null,
    onmessage: null,
    close: vi.fn(),
    send: vi.fn((data: string) => socket.sent.push(data)),
    triggerOpen: () => socket.onopen?.(),
    triggerMessage: (data: unknown) => socket.onmessage?.({ data: JSON.stringify(data) }),
    sent: [],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = vi.fn(() => socket);
});

afterEach(() => {
  useBeadsStore.setState({ issues: [], closedIssues: [], selectedProjectId: null, memories: [], deps: [], kvs: [], sourceHealthByProject: {}, loading: false, error: null, projects: [], selectedIssue: null, agentSessions: [] });
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWebSocket;
  vi.restoreAllMocks();
});

describe("useBeadsLive", () => {
  it("applies beads issue upsert from envelope data.projectId", async () => {
    useBeadsStore.getState().selectProject("project-1");
    renderHook(() => useBeadsLive());

    socket.triggerOpen();
    await act(async () => {
      socket.triggerMessage({
      type: "event",
      channel: "beads:changes",
      event: "beads:issue.upsert",
      seq: 1,
      ts: "2026-05-18T00:00:00Z",
      version: "1",
      boot_id: "boot-1",
      data: {
        projectId: "project-1",
        source: "sqlite",
        issue: {
          id: "issue-1",
          title: "Live issue",
          description: null,
          status: "open",
          priority: 2,
          issue_type: "task",
          owner: null,
          created_at: "2026-05-18T00:00:00Z",
          created_by: null,
          updated_at: "2026-05-18T00:00:00Z",
          project_id: "project-1",
          dependencies: [],
          related_ids: [],
          labels: [],
        },
      },
      });
    });

    expect(useBeadsStore.getState().issues).toHaveLength(1);
    expect(useBeadsStore.getState().issues[0].id).toBe("issue-1");
  });
});
