export const canonicalOrigin: string
export const organization: string
export const employeeDomain: string
export function adminEmails(value: string | undefined): Set<string>
export function organizationRepository(value: unknown): string | undefined
export function validNumericId(value: unknown): value is string
export function deploymentOrigin(value: string | undefined, production: boolean): string
export function acceptsHost(host: string | undefined, origin: string): boolean
