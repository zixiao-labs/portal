import { expect, test } from '@lightning-js/lightning'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { findDocument, openStore } from '../../src/server/store'

test('opening a pre-JWT database adds OAuth flow storage without replacing existing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portal-migration-'))
  const path = join(dir, 'portal.sqlite')
  try {
    {
      using db = new DatabaseSync(path)
      // Prior production schema and representative data, including a deprovisioned employee.
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, employee INTEGER NOT NULL CHECK(employee IN(0,1)),
          github_id TEXT UNIQUE
        );
        CREATE TABLE sessions (
          hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires INTEGER NOT NULL
        );
        CREATE TABLE tokens (
          id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          repository TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL
        );
        CREATE TABLE collections (
          name TEXT PRIMARY KEY, repository TEXT UNIQUE NOT NULL, repository_id TEXT UNIQUE NOT NULL,
          revision TEXT NOT NULL, published INTEGER NOT NULL
        );
        CREATE TABLE articles (
          collection TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
          slug TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, html TEXT NOT NULL, format TEXT NOT NULL,
          PRIMARY KEY (collection, slug)
        );
        CREATE TABLE publish_runs (jwt_id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        INSERT INTO users VALUES (17, 'editor@zixiaolabs.com', 1, '345');
        INSERT INTO users VALUES (18, 'former@zixiaolabs.com', 0, '999');
        INSERT INTO users VALUES (19, 'reader@example.org', 0, '876');
        INSERT INTO sessions VALUES ('old-session-hash', 17, 9999999999);
        INSERT INTO tokens VALUES ('old-token-id', 'old-token-hash', 17, 'zixiao-labs/handbook', 1, 9999999999);
        INSERT INTO collections VALUES ('handbook', 'zixiao-labs/handbook', '42', 'prior-commit', 1);
        INSERT INTO articles VALUES ('handbook', 'start', 'Start', 'Summary', '<p>Body</p>', 'md');
        INSERT INTO publish_runs VALUES ('old-jwt-id', 9999999999);
      `)
    }
    {
      using db = openStore(path)
      expect(db.prepare('SELECT count(*) AS count FROM github_flows').get()?.count).toBe(0)
      expect(db.prepare('SELECT count(*) AS count FROM cli_credentials').get()?.count).toBe(0)
      expect(db.prepare('SELECT count(*) AS count FROM employee_github_links').get()?.count).toBe(0)
      expect(db.prepare('SELECT count(*) AS count FROM suspended_users').get()?.count).toBe(0)
      expect(db.prepare('SELECT count(*) AS count FROM publish_repositories').get()?.count).toBe(0)
    }
    // Startup is idempotent. Rollback also still has the old table and data.
    using db = openStore(path)
    expect(db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual([
      { id: 17, email: 'editor@zixiaolabs.com', employee: 1, github_id: '345' },
      { id: 18, email: 'former@zixiaolabs.com', employee: 0, github_id: '999' },
      { id: 19, email: 'reader@example.org', employee: 0, github_id: '876' },
    ])
    expect(findDocument('handbook', 'start', db)?.html).toBe('<p>Body</p>')
    expect(db.prepare('SELECT repository_id, revision FROM collections').get()).toEqual({
      repository_id: '42',
      revision: 'prior-commit',
    })
    expect(db.prepare('SELECT hash FROM sessions').get()?.hash).toBe('old-session-hash')
    expect(db.prepare('SELECT hash FROM tokens').get()?.hash).toBe('old-token-hash')
    expect(db.prepare('SELECT jwt_id FROM publish_runs').get()?.jwt_id).toBe('old-jwt-id')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  } finally {
    await rm(dir, { force: true, recursive: true })
  }
})
