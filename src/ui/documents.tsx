import { ArrowRight, BookOpen, FileText, LogoGithub } from '@gravity-ui/icons'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { TextField } from '@zixiao-labs/ui-kits-react'
import { llmsPath } from '../doc-path'
import type { Collection, DocumentEntry, DocumentPage } from '../server/store'

function DocumentList({ articles }: { articles: DocumentEntry[] }) {
  return (
    <ul className="document-list">
      {articles.map((entry) => (
        <li key={entry.slug}>
          <Link
            to="/docs/$collection/$"
            params={{ collection: entry.collection, _splat: entry.slug }}
          >
            <FileText aria-hidden />
            <span>
              <b>{entry.title}</b>
              {entry.summary && <small>{entry.summary}</small>}
            </span>
            <em>{entry.format.toUpperCase()}</em>
            <ArrowRight aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function DocumentIndex({
  collections,
  articles,
}: {
  collections: Collection[]
  articles: DocumentEntry[]
}) {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const groups = collections
    .map((collection) => ({
      ...collection,
      entries: articles.filter(
        (article) =>
          article.collection === collection.name &&
          `${article.collection} ${article.title} ${article.summary} ${article.slug}`
            .toLowerCase()
            .includes(query),
      ),
    }))
    .filter(({ entries }) => entries.length)
  return (
    <main id="main" className="workspace">
      <header className="workspace-head">
        <div>
          <p className="eyebrow">
            <span className="index-mark" /> 文档 / LIBRARY
          </p>
          <h1>文档库</h1>
        </div>
        {articles.length > 0 && (
          <TextField
            className="doc-search"
            label="搜索文档"
            placeholder="标题、仓库或路径"
            type="search"
            value={filter}
            onChange={setFilter}
          />
        )}
      </header>
      {!articles.length ? (
        <section className="sheet empty-docs">
          <BookOpen width={32} height={32} aria-hidden />
          <h2>还没有已发布的文档</h2>
          <p>获授权的仓库通过 GitHub Actions 发布文档后，会出现在这里。</p>
        </section>
      ) : !groups.length ? (
        <p role="status">没有与「{filter}」匹配的文档。</p>
      ) : (
        groups.map((group) => (
          <section className="collection sheet" key={group.name}>
            <h2>
              <LogoGithub aria-hidden />
              <Link to="/docs/$collection" params={{ collection: group.name }}>
                {group.name}
              </Link>
            </h2>
            <DocumentList articles={group.entries} />
          </section>
        ))
      )}
    </main>
  )
}

export function DocumentCollection({
  collection,
  articles,
}: {
  collection: Collection
  articles: DocumentEntry[]
}) {
  return (
    <main className="workspace" id="main">
      <header className="workspace-head">
        <div>
          <nav className="eyebrow breadcrumb" aria-label="面包屑">
            <Link to="/docs">文档库</Link>
          </nav>
          <h1 className="collection-name">{collection.name}</h1>
        </div>
        <a className="quiet-link" href={llmsPath(collection.name)}>
          llms.txt
        </a>
      </header>
      <section className="collection sheet" aria-label="仓库文档">
        <DocumentList articles={articles} />
      </section>
    </main>
  )
}

export function DocumentArticle({ page }: { page: DocumentPage }) {
  return (
    <main className="workspace article-page" id="main">
      <nav className="eyebrow breadcrumb" aria-label="面包屑">
        <Link to="/docs">文档库</Link>
        <span aria-hidden> / </span>
        <Link to="/docs/$collection" params={{ collection: page.collection }}>
          {page.collection}
        </Link>
      </nav>
      <article>
        <h1>{page.title}</h1>
        <p className="article-meta">
          {page.format.toUpperCase()} · 更新于{' '}
          {new Date(page.published * 1000).toISOString().slice(0, 10)}（UTC）
        </p>
        <div className="prose" dangerouslySetInnerHTML={{ __html: page.html }} />
      </article>
    </main>
  )
}
