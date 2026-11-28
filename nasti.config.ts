import { defineConfig, tanstackStart } from '@nasti-toolchain/nasti'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export default defineConfig({
  framework: 'react',
  plugins: [
    tanstackStart(),
    {
      // Nasti serves public/ in dev, but its Start build does not copy it into dist/client.
      name: 'portal:public-assets',
      apply: 'build',
      async generateBundle() {
        if (this.environment.name !== 'client') return
        const directory = join(this.environment.config.root, 'public')
        for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
          if (!entry.isFile()) continue
          const path = join(entry.parentPath, entry.name)
          this.emitFile({
            type: 'asset',
            fileName: relative(directory, path).split(sep).join('/'),
            source: await readFile(path),
          })
        }
      },
    },
  ],
  // Nasti 2.11's unbundled Start refresh fails on Start's createCsrfMiddleware graph.
  // Rebuild on edits and serve compiled assets; refresh the browser after a change.
  server: { host: 'localhost', port: 3000, hmr: false },
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          external: [
            /^@modelcontextprotocol\/sdk\//,
            'jose',
            'nodemailer',
            'rehype-parse',
            'rehype-raw',
            'rehype-sanitize',
            'rehype-stringify',
            'remark-gfm',
            'remark-mdx',
            'remark-parse',
            'remark-rehype',
            'unified',
            'zod',
          ],
        },
      },
    },
  },
})
