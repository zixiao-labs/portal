import { notFound } from '@tanstack/react-router'

export function validateDocumentKey(data: { collection: string; slug: string }) {
  if (typeof data?.collection !== 'string' || typeof data?.slug !== 'string') throw notFound()
  return data
}
