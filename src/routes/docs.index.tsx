import { createFileRoute } from '@tanstack/react-router'
import { canonicalOrigin } from '../deployment.mjs'
import { documentIndex } from '../doc-data'
import { DocumentIndex } from '../ui/documents'

export const Route = createFileRoute('/docs/')({
  loader: () => documentIndex(),
  head: () => ({
    meta: [
      { title: '文档库｜紫霄实验室' },
      { name: 'description', content: '浏览紫霄实验室发布的技术文档和项目资料。' },
    ],
    links: [{ rel: 'canonical', href: `${canonicalOrigin}/docs` }],
  }),
  component: DocsRoute,
})

function DocsRoute() {
  return <DocumentIndex {...Route.useLoaderData()} />
}
