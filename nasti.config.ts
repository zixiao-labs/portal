import { defineConfig, tanstackStart } from '@nasti-toolchain/nasti'

export default defineConfig({
  framework: 'react',
  plugins: [tanstackStart()],
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
