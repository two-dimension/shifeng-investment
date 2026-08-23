import net from 'node:net';
import { load } from 'cheerio';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_CONTENT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/pdf',
  'application/xhtml+xml',
  'text/html',
  'text/markdown',
  'text/plain',
]);

function normalizedHost(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}

function isPrivateOrLocalHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIP(host) === 4) return isPrivateIpv4(host);
  if (net.isIP(host) === 6) {
    const normalized = host.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
      || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9')
      || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return false;
}

function parseAndValidateUrl(value, allowedHosts, context = 'source') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${context} URL is invalid`);
  }
  if (url.protocol !== 'https:') throw new Error(`${context} URL must use HTTPS`);
  if (url.username || url.password) throw new Error(`${context} URL must not contain embedded credentials`);
  const host = normalizedHost(url);
  if (isPrivateOrLocalHost(host)) throw new Error(`${context} URL uses a private or local host`);
  if (!allowedHosts.has(host)) throw new Error(`${context} host is not allowlisted`);
  return url;
}

function baseContentType(response) {
  return String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

function contentTypeAllowed(contentType) {
  return SUPPORTED_CONTENT_TYPES.has(contentType) || contentType.endsWith('+json');
}

export async function decodeOfficialDocument(document, format) {
  if (format === 'html') {
    const $ = load(String(document?.text || ''));
    $('script,style,noscript').remove();
    $('h1,h2,h3,h4,h5,h6,p,li,td,th,tr,div,main,article,section').append(' ');
    return $.root().text().replace(/\s+/g, ' ').trim();
  }
  if (format === 'markdown') return String(document?.text || '');
  if (format === 'json') return JSON.stringify(JSON.parse(String(document?.text || '')));
  if (format === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = getDocument({
      data: document?.bytes instanceof Uint8Array ? document.bytes : new Uint8Array(document?.bytes || []),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    let pdf;
    try {
      pdf = await loadingTask.promise;
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => 'str' in item ? item.str : '').join(' '));
      }
      return pages.join('\n').replace(/[ \t]+/g, ' ').trim();
    } finally {
      if (pdf) await pdf.destroy();
      else await loadingTask.destroy();
    }
  }
  throw new Error(`unsupported official document format: ${format}`);
}

export function createOfficialDocumentClient({
  fetchImpl = fetch,
  timeoutMs = 15_000,
  maxBytes = 8 * 1024 * 1024,
  maxRedirects = 3,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be positive');
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error('maxRedirects must be a non-negative integer');

  return {
    async fetchDocument(definition) {
      const allowedHosts = new Set((definition?.allowedHosts || []).map((host) => String(host).trim().toLowerCase()));
      if (allowedHosts.size === 0) throw new Error('source allowedHosts is required');
      let currentUrl = parseAndValidateUrl(definition?.entryUrl, allowedHosts);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`source request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      try {
        for (let redirectCount = 0; ; redirectCount += 1) {
          let response;
          try {
            response = await fetchImpl(currentUrl, {
              redirect: 'manual',
              signal: controller.signal,
              headers: { 'user-agent': 'Shifeng-AI-Dashboard/2.0' },
            });
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            throw error;
          }

          if (REDIRECT_STATUSES.has(response.status)) {
            if (redirectCount >= maxRedirects) throw new Error(`source request has too many redirects (max ${maxRedirects})`);
            const location = response.headers.get('location');
            if (!location) throw new Error(`source redirect ${response.status} is missing location`);
            const redirected = new URL(location, currentUrl);
            try {
              currentUrl = parseAndValidateUrl(redirected, allowedHosts, 'redirect');
            } catch (error) {
              if (/host is not allowlisted/.test(error.message)) throw new Error('redirect host is not allowlisted');
              throw error;
            }
            continue;
          }

          if (!response.ok) throw new Error(`source request failed with HTTP ${response.status}`);
          const contentType = baseContentType(response);
          if (!contentTypeAllowed(contentType)) throw new Error(`unsupported content type: ${contentType || 'missing'}`);
          const declaredBytes = Number(response.headers.get('content-length'));
          if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
            throw new Error(`source body exceeds ${maxBytes} bytes`);
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > maxBytes) throw new Error(`source body exceeds ${maxBytes} bytes`);
          return {
            finalUrl: currentUrl.toString(),
            text: contentType === 'application/pdf' ? null : new TextDecoder().decode(bytes),
            bytes,
            contentType,
            retrievedAt: now().toISOString(),
          };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
