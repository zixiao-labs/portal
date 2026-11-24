import type { Server } from 'node:http'

export function servePortal(
  handler: { fetch: (request: Request) => Response | Promise<Response> },
  options: { origin: string; assets: string },
): Server
