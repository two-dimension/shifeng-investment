import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const migrations = await readD1Migrations('./worker/migrations')

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-08-22',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          TEST_MIGRATIONS: migrations,
          GITHUB_DISPATCH_TOKEN: 'test-dispatch-token',
          RESEARCH_PUBLISH_TOKEN: 'test-publish-token',
          GITHUB_OWNER: 'raywang99131',
          GITHUB_REPO: 'shifeng-investment',
          LEGACY_API_ORIGIN: '',
        },
        d1Databases: ['RESEARCH_DB'],
        r2Buckets: ['RESEARCH_REPORTS'],
      },
    }),
  ],
  test: {
    include: ['worker/**/*.test.ts'],
  },
})
