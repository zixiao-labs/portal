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
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY, hash TEXT NOT NULL, browser_hash TEXT NOT NULL, expires INTEGER NOT NULL,
      created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS login_limits (
      bucket INTEGER PRIMARY KEY, count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      repository TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
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

export function listDocuments(db = store()) {
  const collections = db
    .prepare('SELECT name, repository, revision, published FROM collections ORDER BY name')
    .all() as Collection[]
  const articles = db
    .prepare(
      'SELECT collection, slug, title, summary, format FROM articles ORDER BY collection, slug',
    )
    .all() as Omit<DocumentPage, 'repository' | 'published' | 'html'>[]
  return { collections, articles }
}

export function findDocument(collection: string, slug: string, db = store()) {
  return db
    .prepare(`SELECT articles.*, repository, published FROM articles JOIN collections
    ON articles.collection = collections.name WHERE collection = ? AND slug = ?`)
    .get(collection, slug) as DocumentPage | undefined
}
