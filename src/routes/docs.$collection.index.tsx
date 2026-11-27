import { createFileRoute } from '@tanstack/react-router'
import { canonicalOrigin } from '../deployment.mjs'
import { documentCollection } from '../doc-data'
import { collectionPath, llmsPath } from '../doc-path'
import { DocumentCollection } from '../ui/documents'

export const Route = createFileRoute('/docs/$collection/')({
  loader: ({ params }) => documentCollection({ data: params.collection }),
  head: ({ loaderData }) => {
    if (!loaderData) return {}
    const { name, repository } = loaderData.collection
    return {
      meta: [
        { title: `${name}｜紫霄实验室文档库` },
        { name: 'description', content: `Browse the published documentation for ${repository}.` },
      ],
      links: [
        { rel: 'canonical', href: canonicalOrigin + collectionPath(name) },
        { rel: 'alternate', type: 'text/plain', href: canonicalOrigin + llmsPath(name) },
      ],
    }
  },
  component: CollectionRoute,
})

function CollectionRoute() {
  return <DocumentCollection {...Route.useLoaderData()} />
}
