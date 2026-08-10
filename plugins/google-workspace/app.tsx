/**
 * Settings → Plugins → Google connection section.
 *
 * Status + Connect/Reconnect/Disconnect only. No Gmail or Calendar UI here
 * by design — that surface is the sales workspace; this panel owns the
 * credential lifecycle.
 */
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import type { googleWorkspaceRpcContract } from "./src/rpc.js";

type Status = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  scopes: string[];
  grantedAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  reconnectRequired: boolean;
  scopeUpgradeRequired: boolean;
  requiredScopes: string[];
  redirectUri: string;
};

function ScopeRow({ scope }: { scope: string }) {
  const label = scope.includes("gmail.readonly")
    ? "Read Gmail"
    : scope.includes("gmail.send")
      ? "Send email (approval-gated)"
      : scope.includes("calendar")
        ? "Read & change Calendar (changes approval-gated)"
        : scope;
  return <li style={{ marginLeft: "1rem", listStyle: "disc" }}>{label}</li>;
}

function GoogleSettingsSection() {
  const rpc = useRpc<typeof googleWorkspaceRpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingConsent, setAwaitingConsent] = useState(false);

  const refetch = useCallback(() => {
    rpc.call("status", null).then(
      (value) => setStatus(value as Status),
      (err) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // While the consent tab is open, poll until the callback lands.
  useEffect(() => {
    if (!awaitingConsent) return;
    const timer = setInterval(() => {
      rpc.call("status", null).then((value) => {
        const next = value as Status;
        setStatus(next);
        if (next.connected) setAwaitingConsent(false);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [awaitingConsent, rpc]);

  const connect = () => {
    setBusy(true);
    setError(null);
    rpc.call("beginAuth", null).then(
      ({ url }) => {
        window.open(url, "_blank", "noreferrer");
        setAwaitingConsent(true);
        setBusy(false);
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      },
    );
  };

  const disconnect = () => {
    setBusy(true);
    setError(null);
    rpc.call("disconnect", null).then(
      () => {
        setBusy(false);
        refetch();
      },
      (err) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      },
    );
  };

  if (!status) {
    return <div style={{ padding: "0.5rem 0" }}>Loading Google connection…</div>;
  }

  return (
    <div style={{ display: "grid", gap: "0.75rem", maxWidth: "36rem" }}>
      {!status.configured && (
        <div>
          <p>
            One-time setup: in Google Cloud, create a project with the{" "}
            <b>Gmail API</b> and <b>Google Calendar API</b> enabled, then an
            OAuth client of type <b>Desktop app</b>. Paste its client ID into
            the setting below — after that, connecting is one click.
          </p>
          <p style={{ opacity: 0.7, fontSize: "0.85em" }}>
            Authorized redirect URI to allowlist: <code>{status.redirectUri}</code>
          </p>
        </div>
      )}

      {status.connected && status.scopeUpgradeRequired && (
        <div role="alert">
          New permissions are available (Gmail drafts, calendar management).
          Click <b>Reconnect</b> to grant them — drafts/calendar write tools
          will fail with a permissions error until then.
        </div>
      )}

      {status.connected ? (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          <div>
            Connected as <b>{status.email}</b>
            {status.lastRefreshAt && (
              <span style={{ opacity: 0.7 }}>
                {" "}
                · token refreshed {new Date(status.lastRefreshAt).toLocaleString()}
              </span>
            )}
          </div>
          <ul style={{ margin: 0 }}>
            {status.scopes.map((scope) => (
              <ScopeRow key={scope} scope={scope} />
            ))}
          </ul>
        </div>
      ) : (
        <div>
          {status.reconnectRequired
            ? "Google access was revoked or expired. Reconnect to restore Gmail and Calendar."
            : status.configured
              ? "Not connected. Connect to let BB read Gmail and Calendar (sends and calendar changes always ask first)."
              : "Set the client ID below to enable Connect."}
        </div>
      )}

      {status.lastError && (
        <div role="alert" style={{ color: "var(--destructive, #b91c1c)" }}>
          Last error: {status.lastError}
          {status.consecutiveFailures > 1 &&
            ` (${status.consecutiveFailures} consecutive failures)`}
        </div>
      )}
      {error && (
        <div role="alert" style={{ color: "var(--destructive, #b91c1c)" }}>
          {error}
        </div>
      )}
      {awaitingConsent && !status.connected && (
        <div style={{ opacity: 0.7 }}>
          Finish signing in in the browser tab that just opened…
        </div>
      )}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        {status.connected ? (
          <>
            <Button variant="outline" disabled={busy} onClick={connect}>
              Reconnect
            </Button>
            <Button variant="destructive" disabled={busy} onClick={disconnect}>
              Disconnect
            </Button>
          </>
        ) : (
          <Button disabled={busy || !status.configured} onClick={connect}>
            Connect Google
          </Button>
        )}
      </div>
    </div>
  );
}

function CalendarChangeApproval({ interaction, submit }: any) {
  const p = (interaction?.payload ?? {}) as Record<string, any>;
  const rows: Array<[string, string]> = [];
  if (p.summary) rows.push(["Event", String(p.summary)]);
  if (p.email) rows.push(["Person", String(p.email)]);
  if (p.invitees) rows.push(["Invitees", (p.invitees as string[]).join(", ")]);
  if (p.attendees) rows.push(["Attendees", (p.attendees as string[]).join(", ")]);
  if (p.newStart?.dateTime) rows.push(["New start", String(p.newStart.dateTime)]);
  if (p.newEnd?.dateTime) rows.push(["New end", String(p.newEnd.dateTime)]);
  if (p.reason) rows.push(["Why", String(p.reason)]);
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td style={{ opacity: 0.7, paddingRight: "1rem" }}>{label}</td>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <Button onClick={() => submit({ approved: true })}>Approve</Button>
        <Button variant="outline" onClick={() => submit({ approved: false })}>
          Decline
        </Button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "calendar-change-approval",
    component: CalendarChangeApproval,
  });
  app.slots.settingsSection({
    id: "google-account",
    title: "Google account",
    description:
      "Connect Gmail and Google Calendar so BB can monitor them and act with your approval.",
    component: GoogleSettingsSection,
  });
});
