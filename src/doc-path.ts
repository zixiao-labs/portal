export const collectionPath = (collection: string) => `/docs/${collection}`
export const articlePath = (collection: string, slug: string) =>
  `${collectionPath(collection)}/${slug}`
export const llmsPath = (collection: string) => `${collectionPath(collection)}/llms.txt`
