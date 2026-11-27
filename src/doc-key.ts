import { notFound } from '@tanstack/react-router'

export function validateCollectionName(name: string) {
  if (typeof name !== 'string') throw notFound()
  return name
}

export function validateDocumentKey(data: { collection: string; slug: string }) {
  if (typeof data?.collection !== 'string' || typeof data?.slug !== 'string') throw notFound()
  return data
}
