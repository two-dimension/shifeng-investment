import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withMissingExternalCollectors(fetchImpl, run) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'news-intelligence-test-'));
  const previousRoot = process.env.NEWS_INTELLIGENCE_ROOT;
  const previousFollowerCache = process.env.X_FOLLOWER_CACHE_FILE;
  const previousFetch = global.fetch;

  process.env.NEWS_INTELLIGENCE_ROOT = path.join(tempRoot, 'missing-news-skill');
  process.env.X_FOLLOWER_CACHE_FILE = path.join(tempRoot, 'x-followers.json');
  await writeFile(process.env.X_FOLLOWER_CACHE_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    accounts: { openai: { followers: 1_000_000 } },
  }));
  global.fetch = fetchImpl;

  try {
    const { fetchNewsIntelligence } = await import(`./newsIntelligence.js?fallback-test=${Date.now()}`);
    await run(fetchNewsIntelligence);
  } finally {
    global.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.NEWS_INTELLIGENCE_ROOT;
    else process.env.NEWS_INTELLIGENCE_ROOT = previousRoot;
    if (previousFollowerCache === undefined) delete process.env.X_FOLLOWER_CACHE_FILE;
    else process.env.X_FOLLOWER_CACHE_FILE = previousFollowerCache;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const emptyRssResponse = () => new Response('<?xml version="1.0"?><rss><channel></channel></rss>', {
  status: 200,
  headers: { 'content-type': 'application/rss+xml' },
});

test('uses the built-in RSS collector when the external news scripts are unavailable', async () => {
  const publishedAt = new Date().toUTCString();
  await withMissingExternalCollectors(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.bls.gov')) {
      return new Response(JSON.stringify({ Results: { series: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('hn.algolia.com')) {
      return new Response(JSON.stringify({ hits: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://openai.com/blog/rss.xml') {
      return new Response(`<?xml version="1.0"?><rss><channel><item>
        <title>OpenAI ships a new investing research model</title>
        <link>https://openai.com/example-latest-news</link>
        <pubDate>${publishedAt}</pubDate>
        <description>Current official product news.</description>
      </item></channel></rss>`, {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
      });
    }
    return emptyRssResponse();
  }, async (fetchNewsIntelligence) => {
    const result = await fetchNewsIntelligence({ since: '24h', mode: 'quick', limit: 2 });
    const latest = result.news.find((item) => item.title === 'OpenAI ships a new investing research model');
    assert.ok(latest, 'expected current RSS news from the built-in collector');
    assert.equal(latest.source, 'OpenAI Blog');
    assert.equal(latest.collectionChannel, 'rss');
  });
});

test('built-in Hacker News collection excludes stories older than the requested lookback', async () => {
  await withMissingExternalCollectors(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('api.bls.gov')) {
      return new Response(JSON.stringify({ Results: { series: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('hn.algolia.com')) {
      return new Response(JSON.stringify({
        hits: [{
          objectID: 'old-story',
          title: 'A stale AI story from years ago',
          url: 'https://example.com/old-ai-story',
          created_at: '2024-10-23T13:18:17Z',
          points: 100,
          num_comments: 20,
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return emptyRssResponse();
  }, async (fetchNewsIntelligence) => {
    const result = await fetchNewsIntelligence({ since: '7d', mode: 'quick', limit: 2 });
    assert.equal(result.news.some((item) => item.title === 'A stale AI story from years ago'), false);
  });
});
