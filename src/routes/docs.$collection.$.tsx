import { createFileRoute, notFound } from '@tanstack/react-router'
import { canonicalOrigin } from '../deployment.mjs'
import { documentPage } from '../doc-data'
import { articlePath } from '../doc-path'
import { DocumentArticle } from '../ui/documents'

export const Route = createFileRoute('/docs/$collection/$')({
  loader: ({ params }) => {
    if (!params._splat) throw notFound()
    return documentPage({ data: { collection: params.collection, slug: params._splat } })
  },
  head: ({ loaderData }) =>
    loaderData
      ? {
          meta: [
            { title: `${loaderData.title}｜紫霄实验室文档库` },
            {
              name: 'description',
              content: loaderData.summary || `阅读紫霄实验室的 ${loaderData.title}。`,
            },
            { property: 'og:type', content: 'article' },
          ],
          links: [
            {
              rel: 'canonical',
              href: canonicalOrigin + articlePath(loaderData.collection, loaderData.slug),
            },
          ],
        }
      : {},
  component: ArticleRoute,
})

function ArticleRoute() {
  return <DocumentArticle page={Route.useLoaderData()} />
}
