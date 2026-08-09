/**
 * Sales ↔ google-workspace connector integration: with no manual settings
 * token, the sales plugin vends a fresh access token from the connector per
 * cycle and polls Gmail + Calendar with it; when the connector is absent it
 * falls back to the manual settings token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "./server.js";

function fakeGoogleApi(capturedAuth: string[]) {
  return vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = init?.headers ?? {};
    capturedAuth.push(String(headers.authorization ?? ""));
    const json = async () => {
      if (url.includes("/gmail/v1/users/me/messages?")) {
        return { messages: [], resultSizeEstimate: 0 };
      }
      if (url.includes("/calendar/v3/calendars/")) {
        return { items: [], nextSyncToken: "cal-1" };
      }
      return {};
    };
    return {
      ok: true,
      status: 200,
      json,
      text: async () => "",
    } as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sales google runtime via the connector", () => {
  it("polls Gmail and Calendar with the connector-vended token", async () => {
    const capturedAuth: string[] = [];
    vi.stubGlobal("fetch", fakeGoogleApi(capturedAuth));
    const connectorCalls: string[] = [];
    const host = createFakePluginHost({
      pluginId: "sales",
      sdk: {
        plugins: {
          callRpc: async (args: { pluginId: string; method: string }) => {
            if (args.pluginId === "google-workspace") {
              connectorCalls.push(args.method);
              return {
                token: "vended-token-1",
                expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                email: "me@example.com",
              };
            }
            return { ingested: 0, diagnoses: 0, autoFixed: 0, escalated: 0 };
          },
        },
      },
    });
    await plugin(host.bb, { now: () => new Date("2026-08-09T12:00:00Z") });

    await host.harness.runSchedule("google-work-capability-poll");

    expect(connectorCalls).toContain("accessToken");
    expect(capturedAuth.length).toBeGreaterThanOrEqual(2); // gmail + calendar
    expect(new Set(capturedAuth)).toEqual(
      new Set(["Bearer vended-token-1"]),
    );
  });

  it("falls back to the manual settings token when the connector is unavailable", async () => {
    const capturedAuth: string[] = [];
    vi.stubGlobal("fetch", fakeGoogleApi(capturedAuth));
    const host = createFakePluginHost({
      pluginId: "sales",
      settings: {
        googleAccessToken: "manual-token",
        googleUserEmail: "me@example.com",
      },
      sdk: {
        plugins: {
          callRpc: async () => {
            throw new Error("plugin not found: google-workspace");
          },
        },
      },
    });
    await plugin(host.bb, { now: () => new Date("2026-08-09T12:00:00Z") });

    await host.harness.runSchedule("google-work-capability-poll");

    expect(capturedAuth.length).toBeGreaterThanOrEqual(2);
    expect(new Set(capturedAuth)).toEqual(new Set(["Bearer manual-token"]));
  });
});
