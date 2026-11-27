import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { validateCollectionName, validateDocumentKey } from './doc-key'
import { findCollection, findDocument, listDocuments } from './server/store'

export const documentIndex = createServerFn({ method: 'GET' }).handler(() => listDocuments())

export const documentCollection = createServerFn({ method: 'GET' })
  .validator(validateCollectionName)
  .handler(({ data }) => {
    const collection = findCollection(data)
    if (!collection) throw notFound()
    return collection
  })

export const documentPage = createServerFn({ method: 'GET' })
  .validator(validateDocumentKey)
  .handler(({ data }) => {
    const page = findDocument(data.collection, data.slug)
    if (!page) throw notFound()
    return page
  })
