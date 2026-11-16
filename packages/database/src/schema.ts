// The same PostgreSQL schema runs in embedded PGlite and a regular PostgreSQL server.
export const migrations = [
  `CREATE TABLE IF NOT EXISTS owners (id uuid PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS agents (
    id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), document jsonb NOT NULL,
    UNIQUE(id, owner_id))`,
  `CREATE TABLE IF NOT EXISTS facts (
    id uuid PRIMARY KEY, owner_id uuid NOT NULL, agent_id uuid NOT NULL, document jsonb NOT NULL,
    UNIQUE(id, owner_id), FOREIGN KEY(agent_id, owner_id) REFERENCES agents(id, owner_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS meetings (
    id uuid PRIMARY KEY, owner_id uuid NOT NULL, agent_id uuid NOT NULL,
    status text NOT NULL CHECK(status IN ('ACTIVE','COMPLETED','REVOKED','EXPIRED','DISCONNECTED')),
    idempotency_key text NOT NULL, request_hash text NOT NULL,
    reserved_seconds integer NOT NULL CHECK(reserved_seconds >= 0),
    actual_seconds integer NOT NULL DEFAULT 0 CHECK(actual_seconds >= 0),
    document jsonb NOT NULL, UNIQUE(id, owner_id), UNIQUE(owner_id, idempotency_key),
    FOREIGN KEY(agent_id, owner_id) REFERENCES agents(id, owner_id) ON DELETE CASCADE)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_active_meeting_per_owner ON meetings(owner_id) WHERE status = 'ACTIVE'`,
  `CREATE TABLE IF NOT EXISTS meeting_sources (
    meeting_id uuid NOT NULL, owner_id uuid NOT NULL, source_id uuid NOT NULL, source_version integer NOT NULL,
    PRIMARY KEY(meeting_id, source_id),
    FOREIGN KEY(meeting_id, owner_id) REFERENCES meetings(id, owner_id) ON DELETE CASCADE,
    FOREIGN KEY(source_id, owner_id) REFERENCES facts(id, owner_id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS session_records (
    meeting_id uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE, document jsonb NOT NULL)`,
  // Usage survives content deletion; it contains no transcript, meeting link, or source text.
  `CREATE TABLE IF NOT EXISTS usage_ledger (
    id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id),
    reserved_seconds integer NOT NULL CHECK(reserved_seconds >= 0),
    actual_seconds integer NOT NULL CHECK(actual_seconds >= 0))`,
  `CREATE TABLE IF NOT EXISTS audits (
    id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES owners(id), resource_id uuid,
    action text NOT NULL, created_at timestamptz NOT NULL)`,
];
