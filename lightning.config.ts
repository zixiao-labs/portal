import { defineConfig } from '@lightning-js/lightning/config'

export default defineConfig({
  environments: {
    ssr: {
      build: {
        target: 'esnext',
        rolldownOptions: {
          // Keep the test registry shared with the runner and let Node load CommonJS packages.
          external: [
            '@lightning-js/lightning',
            'playwright',
            'pngjs',
            'sirv',
            'nodemailer',
            'jose',
            'unified',
            'rehype-parse',
            'rehype-raw',
            'rehype-sanitize',
            'rehype-stringify',
            'remark-gfm',
            'remark-mdx',
            'remark-parse',
            'remark-rehype',
          ],
        },
      },
    },
  },
  test: {
    // Nasti 2.11 workers loading nasti.config.ts in the same millisecond share a temp file.
    maxWorkers: 1,
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { test: { name: 'visual', include: ['tests/visual/**/*.test.ts'], testTimeout: 30_000 } },
    ],
  },
})
