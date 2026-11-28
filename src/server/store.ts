import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type User = { id: number; email: string; employee: number; github_id: string | null }
export type Article = { slug: string; title: string; summary: string; html: string; format: string }
export type Collection = {
  name: string
  repository: string
  revision: string
  published: number
}
export type DocumentPage = Article & { collection: string; repository: string; published: number }

let current: DatabaseSync | undefined
export function store() {
  return (current ??= openStore(process.env.SQLITE_PATH || 'data/portal.sqlite'))
}

export function openStore(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, employee INTEGER NOT NULL CHECK(employee IN(0,1)),
      github_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS cli_credentials (
      session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
      hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suspended_users (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS github_flows (
      state_hash TEXT PRIMARY KEY, verifier_hash TEXT NOT NULL, expires INTEGER NOT NULL,
      session_hash TEXT REFERENCES sessions(hash) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS github_flows_session ON github_flows(session_hash);
    CREATE TABLE IF NOT EXISTS employee_github_links (
      github_id TEXT NOT NULL PRIMARY KEY REFERENCES users(github_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY, hash TEXT NOT NULL, browser_hash TEXT NOT NULL, expires INTEGER NOT NULL,
      created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS login_limits (
      bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT PRIMARY KEY, repository TEXT UNIQUE NOT NULL, repository_id TEXT UNIQUE NOT NULL,
      revision TEXT NOT NULL, published INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS articles (
      collection TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
      slug TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, html TEXT NOT NULL, format TEXT NOT NULL,
      PRIMARY KEY (collection, slug)
    );
    CREATE TABLE IF NOT EXISTS publish_runs (
      jwt_id TEXT PRIMARY KEY, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS publish_repositories (
      id TEXT NOT NULL PRIMARY KEY, repository TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS mcp_grants (
      flow_id TEXT NOT NULL PRIMARY KEY,
      credential_hash TEXT UNIQUE,
      session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
      client_hash TEXT NOT NULL, resource TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      code_challenge TEXT, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mcp_grants_session ON mcp_grants(session_hash);
    CREATE INDEX IF NOT EXISTS mcp_grants_expiry ON mcp_grants(expires);
    CREATE INDEX IF NOT EXISTS mcp_grants_client ON mcp_grants(client_hash);
    CREATE TABLE IF NOT EXISTS oauth_apps (
      client_id TEXT PRIMARY KEY, client_hash TEXT NOT NULL UNIQUE,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('docs:read', 'oauth:apps', 'docs:repositories'))
    );
    CREATE INDEX IF NOT EXISTS oauth_apps_owner ON oauth_apps(owner_id);
    CREATE TABLE IF NOT EXISTS oauth_consumed_flows (
      id TEXT PRIMARY KEY, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_consumed_flows_expiry ON oauth_consumed_flows(expires);
  `)
  return db
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export type DocumentEntry = Omit<DocumentPage, 'repository' | 'published' | 'html'>

const collectionColumns = 'SELECT name, repository, revision, published FROM collections'
const articleColumns = 'SELECT collection, slug, title, summary, format FROM articles'

export function listDocuments(db = store()) {
  const collections = db.prepare(`${collectionColumns} ORDER BY name`).all() as Collection[]
  const articles = db
    .prepare(`${articleColumns} ORDER BY collection, slug`)
    .all() as DocumentEntry[]
  return { collections, articles }
}

export function searchDocuments(
  query: string,
  collection: string | undefined,
  offset: number,
  db = store(),
) {
  const text = query.toLowerCase()
  return db
    .prepare(`${articleColumns}
    WHERE (? IS NULL OR collection=?) AND (
      ?='' OR instr(lower(title), ?) OR instr(lower(summary), ?) OR instr(lower(slug), ?)
    ) ORDER BY collection, slug LIMIT 21 OFFSET ?`)
    .all(collection ?? null, collection ?? null, text, text, text, text, offset) as DocumentEntry[]
}

export function findCollection(name: string, db = store()) {
  const collection = db.prepare(`${collectionColumns} WHERE name=?`).get(name) as
    | Collection
    | undefined
  if (!collection) return
  const articles = db
    .prepare(`${articleColumns} WHERE collection=? ORDER BY slug`)
    .all(name) as DocumentEntry[]
  return { collection, articles }
}

export function findDocument(collection: string, slug: string, db = store()) {
  return db
    .prepare(`SELECT articles.*, repository, published FROM articles JOIN collections
    ON articles.collection = collections.name WHERE collection = ? AND slug = ?`)
    .get(collection, slug) as DocumentPage | undefined
}

export function canPublish(id: string, repository: string, db = store()) {
  return Boolean(
    db
      .prepare('SELECT 1 FROM publish_repositories WHERE id=? AND repository=?')
      .get(id, repository),
  )
}
