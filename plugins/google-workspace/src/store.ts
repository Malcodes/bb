/**
 * Connector credential + status store.
 *
 * Isolation contract: the Google refresh token lives ONLY in this plugin's
 * own SQLite file (<dataDir>/plugins/google-workspace/data.db) — never in
 * plugin KV (bb.db), workspace state, settings responses, or RPC output.
 * Access tokens live only in server memory. Agents and generated tools get
 * read/write capability through the sales plugin's approval-gated actions,
 * never a credential.
 */
import type { BbPluginApi } from "@bb/plugin-sdk";

export interface StoredCredential {
  refreshToken: string;
  email: string;
  scopes: string;
  grantedAt: string;
}

export interface PendingAuth {
  state: string;
  verifier: string;
  createdAt: string;
}

export interface ConnectorHealth {
  lastRefreshAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  reconnectRequired: boolean;
}

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export class ConnectorStore {
  private db: Database;

  constructor(storage: BbPluginApi["storage"]) {
    this.db = storage.database();
    storage.migrate(this.db, [
      `CREATE TABLE IF NOT EXISTS credential (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        refresh_token TEXT NOT NULL,
        email TEXT NOT NULL,
        scopes TEXT NOT NULL,
        granted_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS pending_auth (
        state TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS health (
        key TEXT PRIMARY KEY,
        value TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        reason TEXT NOT NULL,
        outcome TEXT NOT NULL
      )`,
    ]);
  }

  saveCredential(credential: StoredCredential): void {
    this.db
      .prepare(
        `INSERT INTO credential (id, refresh_token, email, scopes, granted_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           refresh_token = excluded.refresh_token,
           email = excluded.email,
           scopes = excluded.scopes,
           granted_at = excluded.granted_at`,
      )
      .run(
        credential.refreshToken,
        credential.email,
        credential.scopes,
        credential.grantedAt,
      );
    this.saveHealth({
      consecutiveFailures: 0,
      reconnectRequired: false,
      lastError: undefined,
      lastRefreshAt: credential.grantedAt,
    });
  }

  getCredential(): StoredCredential | null {
    const row = this.db
      .prepare(
        `SELECT refresh_token, email, scopes, granted_at FROM credential WHERE id = 1`,
      )
      .get() as
      | { refresh_token: string; email: string; scopes: string; granted_at: string }
      | undefined;
    if (!row) return null;
    return {
      refreshToken: row.refresh_token,
      email: row.email,
      scopes: row.scopes,
      grantedAt: row.granted_at,
    };
  }

  clearCredential(): void {
    this.db.prepare(`DELETE FROM credential WHERE id = 1`).run();
  }

  savePendingAuth(pending: PendingAuth): void {
    // One flow at a time: starting a new connect invalidates older states.
    this.db.prepare(`DELETE FROM pending_auth`).run();
    this.db
      .prepare(
        `INSERT INTO pending_auth (state, verifier, created_at) VALUES (?, ?, ?)`,
      )
      .run(pending.state, pending.verifier, pending.createdAt);
  }

  /** Returns and consumes the pending auth for `state`, or null on mismatch. */
  takePendingAuth(state: string): PendingAuth | null {
    const row = this.db
      .prepare(`SELECT state, verifier, created_at FROM pending_auth WHERE state = ?`)
      .get(state) as
      | { state: string; verifier: string; created_at: string }
      | undefined;
    this.db.prepare(`DELETE FROM pending_auth`).run();
    if (!row) return null;
    return { state: row.state, verifier: row.verifier, createdAt: row.created_at };
  }

  getHealth(): ConnectorHealth {
    const rows = this.db.prepare(`SELECT key, value FROM health`).all() as Array<{
      key: string;
      value: string | null;
    }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));
    return {
      lastRefreshAt: map.get("lastRefreshAt") ?? undefined,
      lastError: map.get("lastError") ?? undefined,
      consecutiveFailures: Number(map.get("consecutiveFailures") ?? "0"),
      reconnectRequired: map.get("reconnectRequired") === "1",
    };
  }

  saveHealth(health: ConnectorHealth): void {
    const upsert = this.db.prepare(
      `INSERT INTO health (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const put = (key: string, value: string | null) => upsert.run(key, value);
    put("lastRefreshAt", health.lastRefreshAt ?? null);
    put("lastError", health.lastError ?? null);
    put("consecutiveFailures", String(health.consecutiveFailures));
    put("reconnectRequired", health.reconnectRequired ? "1" : "0");
  }
}
