import { organizationRepository, validNumericId } from '../deployment.mjs'
import { HttpError } from './http'
import { store } from './store'

export function registerRepository(input: { id?: unknown; repository?: unknown }) {
  const id = typeof input.id === 'string' ? input.id.trim() : undefined
  const repository = organizationRepository(
    typeof input.repository === 'string' ? input.repository.trim() : undefined,
  )
  if (!repository || !validNumericId(id))
    throw new HttpError(400, '请输入 zixiao-labs 组织下的仓库全名和数字 ID。')
  const result = store()
    .prepare('INSERT OR IGNORE INTO publish_repositories VALUES (?, ?)')
    .run(id, repository)
  if (!result.changes)
    throw new HttpError(409, '该仓库名称或 ID 已获授权。若要更改，请先撤销原授权。')
  return { id, repository }
}

export function unregisterRepository(id: string) {
  if (!validNumericId(id)) throw new HttpError(400, '请输入有效的仓库数字 ID。')
  const result = store().prepare('DELETE FROM publish_repositories WHERE id=?').run(id)
  return { id, removed: Boolean(result.changes) }
}
