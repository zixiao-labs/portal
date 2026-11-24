export const canonicalOrigin: string
export const organization: string
export const employeeDomain: string
export function deploymentOrigin(value: string | undefined, production: boolean): string
export function acceptsHost(host: string | undefined, origin: string): boolean
