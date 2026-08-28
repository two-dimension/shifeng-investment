import { cloudflarePool } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['worker/**/*.test.ts'],
    pool: cloudflarePool({
      miniflare: {
        compatibilityDate: '2026-08-28',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
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
  },
})
