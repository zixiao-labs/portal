import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { HttpError, json } from './http'
import { mcpAccess, mcpChallenge, mcpPath } from './mcp-auth'
import { registerRepository, unregisterRepository } from './repositories'
import { store, transaction } from './store'

export async function mcp(request: Request, origin: string) {
  const source = request.headers.get('origin')
  if (source !== null && source !== origin) return json({ error: 'Untrusted Origin.' }, 403)
  const authorization = request.headers.get('authorization')
  const token = authorization?.match(/^Bearer (zxm_[A-Za-z0-9_-]{43})$/i)?.[1]
  const resource = origin + mcpPath
  if (!token || !mcpAccess(token, resource)) return mcpChallenge(authorization !== null)
  if (request.method !== 'POST')
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    })

  const server = new McpServer({ name: 'zixiao-portal', version: '1.0.0' })
  const write = (operation: () => Record<string, unknown>) => {
    try {
      const result = transaction(store(), () => {
        if (!mcpAccess(token, resource))
          throw new HttpError(403, 'MCP authorization is no longer valid.')
        return operation()
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      }
    } catch (error) {
      if (!(error instanceof HttpError))
        throw new Error('Could not update repository publishing access.')
      return { content: [{ type: 'text' as const, text: error.message }], isError: true }
    }
  }
  const id = z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .describe('Numeric GitHub repository ID, as a string.')
  server.registerTool(
    'register_publish_repository',
    {
      description:
        'Grant a zixiao-labs GitHub repository permission to publish public documentation via GitHub Actions. Does not upload documents.',
      inputSchema: {
        id,
        repository: z.string().max(112).describe('Full name, e.g. zixiao-labs/example.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => write(() => registerRepository(input)),
  )
  server.registerTool(
    'unregister_publish_repository',
    {
      description:
        'Revoke future documentation publishing for a GitHub repository by numeric ID. Does not remove existing public documents.',
      inputSchema: { id },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ id: repositoryId }) => write(() => unregisterRepository(repositoryId)),
  )

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 16 * 1024,
  })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('X-Robots-Tag', 'noindex')
    return response
  } finally {
    await server.close()
  }
}
