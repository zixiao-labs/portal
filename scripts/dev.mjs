import { spawn } from 'node:child_process'
import { deploymentOrigin } from '../src/deployment.mjs'

const origin = new URL(deploymentOrigin(process.env.PORTAL_ORIGIN, false))
if (origin.protocol !== 'http:')
  throw new Error('Use a loopback HTTP origin for local development.')
const child = spawn(
  process.execPath,
  [
    'node_modules/@nasti-toolchain/nasti/bin/nasti.js',
    'dev',
    '--host',
    origin.hostname === '[::1]' ? '::1' : origin.hostname,
    '--port',
    origin.port || '80',
  ],
  { stdio: 'inherit' },
)
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
