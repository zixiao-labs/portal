import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { validateDocumentKey } from './doc-key'
import { findDocument, listDocuments } from './server/store'

export const documentIndex = createServerFn({ method: 'GET' }).handler(() => listDocuments())

export const documentPage = createServerFn({ method: 'GET' })
  .validator(validateDocumentKey)
  .handler(({ data }) => {
    const page = findDocument(data.collection, data.slug)
    if (!page) throw notFound()
    return page
  })
