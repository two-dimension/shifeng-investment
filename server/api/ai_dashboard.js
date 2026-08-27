import crypto from 'node:crypto';
import express from 'express';
import { createAiDashboardServiceFromEnv } from '../lib/aiDashboardService.js';
import { createIceCdsPipelineFromEnv } from '../lib/iceCdsPipeline.js';
import { DASHBOARD_SOURCE_KEYS } from '../lib/publicSourceRegistry.js';

const COOKIE_NAME = 'ai_dashboard_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const REFRESH_SOURCES = new Set(DASHBOARD_SOURCE_KEYS);
const CDS_IMPORT_FIELDS = new Set(['iceText', 'discountCurve', 'officialSpreads']);
const MAX_ICE_TEXT_BYTES = 1024 * 1024;
const MAX_CURVE_NODES = 10_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function jsonError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(secret, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function verifySessionToken(token, secret, nowMs) {
  if (!token || !secret) return null;
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra) return null;
  const expected = sign(payload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(parsed.exp) && parsed.exp > nowMs ? { expiresAt: parsed.exp } : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

function sessionCookie(token, isProduction) {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    isProduction ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function clearedSessionCookie(isProduction) {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    isProduction ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function defaultIsLocalWriter(req) {
  const address = String(req.ip || req.socket?.remoteAddress || '').toLowerCase();
  const isLoopback = address === '::1'
    || address === 'localhost'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
  if (!isLoopback) return false;

  const origin = String(req.get('origin') || '').trim();
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === `${req.protocol}:`
      && parsed.host.toLowerCase() === String(req.get('host') || '').toLowerCase();
  } catch {
    return false;
  }
}

function validateCdsImportBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, code: 'ICE_CDS_INVALID_IMPORT', message: '导入内容必须是 JSON 对象' };
  }
  const unknown = Object.keys(body).filter((key) => !CDS_IMPORT_FIELDS.has(key));
  if (unknown.length > 0) {
    return { status: 400, code: 'ICE_CDS_UNKNOWN_FIELDS', message: `不支持的导入字段：${unknown.join('、')}` };
  }
  if (typeof body.iceText !== 'string' || body.iceText.trim() === '') {
    return { status: 400, code: 'ICE_CDS_INVALID_TEXT', message: 'iceText 必须是非空字符串' };
  }
  if (Buffer.byteLength(body.iceText, 'utf8') > MAX_ICE_TEXT_BYTES) {
    return { status: 413, code: 'ICE_CDS_TEXT_TOO_LARGE', message: 'ICE 表格文本不能超过 1 MiB' };
  }
  if (!body.discountCurve || typeof body.discountCurve !== 'object' || Array.isArray(body.discountCurve)) {
    return { status: 400, code: 'ICE_CDS_INVALID_CURVE', message: 'discountCurve 必须是对象' };
  }
  if (!Array.isArray(body.discountCurve.nodes) || body.discountCurve.nodes.length > MAX_CURVE_NODES) {
    return { status: 400, code: 'ICE_CDS_INVALID_CURVE', message: '折现曲线必须包含不超过 10,000 个节点' };
  }
  if (body.officialSpreads !== undefined
    && (!body.officialSpreads || typeof body.officialSpreads !== 'object')) {
    return { status: 400, code: 'ICE_CDS_INVALID_BENCHMARK', message: 'officialSpreads 必须是对象或数组' };
  }
  return null;
}

function isExpectedCdsInputError(error) {
  return ['IceCdsPipelineError', 'IceCdsImportError', 'CdsModelValidationError'].includes(error?.name);
}

export function createAiDashboardRouter({
  service = createAiDashboardServiceFromEnv(),
  cdsPipeline = createIceCdsPipelineFromEnv(),
  isLocalWriter = defaultIsLocalWriter,
  accessCode = process.env.AI_DASHBOARD_ACCESS_CODE || '',
  sessionSecret = process.env.AI_DASHBOARD_SESSION_SECRET || '',
  publicAccess = true,
  now = () => new Date(),
  isProduction = process.env.NODE_ENV === 'production',
  maxAttempts = 5,
  windowMs = 15 * 60 * 1000,
} = {}) {
  const router = express.Router();
  const failedAttempts = new Map();
  const isConfigured = () => Boolean(accessCode && sessionSecret);
  const clientKey = (req) => req.ip || req.socket?.remoteAddress || 'unknown';
  const readSession = (req) => {
    if (!isConfigured()) return null;
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionToken(cookies[COOKIE_NAME], sessionSecret, now().getTime());
  };
  const recentFailures = (key) => {
    const cutoff = now().getTime() - windowMs;
    const recent = (failedAttempts.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length > 0) failedAttempts.set(key, recent);
    else failedAttempts.delete(key);
    return recent;
  };

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/session', (req, res) => {
    if (publicAccess) return res.json({ success: true, authenticated: true, publicAccess: true });
    if (!isConfigured()) {
      return jsonError(res, 503, 'AI_DASHBOARD_AUTH_NOT_CONFIGURED', 'AI 看板访问控制尚未配置');
    }
    const key = clientKey(req);
    const failures = recentFailures(key);
    if (failures.length >= maxAttempts) {
      return jsonError(res, 429, 'AI_DASHBOARD_RATE_LIMITED', '失败次数过多，请稍后重试');
    }
    if (!safeEqual(req.body?.accessCode, accessCode)) {
      failures.push(now().getTime());
      failedAttempts.set(key, failures);
      return jsonError(res, 401, 'AI_DASHBOARD_ACCESS_DENIED', '访问口令不正确');
    }
    failedAttempts.delete(key);
    const expiresAt = now().getTime() + SESSION_MAX_AGE_SECONDS * 1000;
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(sessionSecret, expiresAt), isProduction));
    return res.json({ success: true, authenticated: true, expiresAt: new Date(expiresAt).toISOString() });
  });

  router.get('/session', (req, res) => {
    if (publicAccess) return res.json({ success: true, authenticated: true, publicAccess: true });
    const session = readSession(req);
    if (!session) return jsonError(res, 401, 'AI_DASHBOARD_SESSION_REQUIRED', '需要 AI 看板访问会话');
    return res.json({ success: true, authenticated: true, expiresAt: new Date(session.expiresAt).toISOString() });
  });

  router.delete('/session', (_req, res) => {
    res.setHeader('Set-Cookie', clearedSessionCookie(isProduction));
    return res.json({ success: true, authenticated: false });
  });

  router.use((req, res, next) => {
    if (publicAccess) return next();
    if (!isConfigured()) return jsonError(res, 503, 'AI_DASHBOARD_AUTH_NOT_CONFIGURED', 'AI 看板访问控制尚未配置');
    const session = readSession(req);
    if (!session) return jsonError(res, 401, 'AI_DASHBOARD_SESSION_REQUIRED', '需要 AI 看板访问会话');
    req.aiDashboardSession = session;
    return next();
  });

  router.get('/', async (req, res) => {
    try {
      return res.json({
        success: true,
        data: await service.getSnapshot(),
        publicAccess,
        sessionExpiresAt: req.aiDashboardSession
          ? new Date(req.aiDashboardSession.expiresAt).toISOString()
          : null,
      });
    } catch (error) {
      console.error('[ai-dashboard] snapshot error:', error);
      return jsonError(res, 500, 'AI_DASHBOARD_READ_FAILED', 'AI 看板数据读取失败');
    }
  });

  router.post('/refresh', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const hasSources = Object.prototype.hasOwnProperty.call(body, 'sources');
    const hasForce = Object.prototype.hasOwnProperty.call(body, 'force');
    const validSources = !hasSources || (Array.isArray(body.sources)
      && body.sources.length > 0
      && body.sources.every((source) => REFRESH_SOURCES.has(source)));
    const validForce = !hasForce || typeof body.force === 'boolean';
    if (!validSources || !validForce) {
      return jsonError(
        res,
        400,
        'AI_DASHBOARD_INVALID_REFRESH_SOURCE',
        `刷新范围必须是 ${DASHBOARD_SOURCE_KEYS.join('、')}，force 必须是布尔值`,
      );
    }
    const refreshOptions = hasSources || hasForce
      ? { ...(hasSources ? { sources: body.sources } : {}), ...(hasForce ? { force: body.force } : {}) }
      : undefined;
    try {
      return res.json({
        success: true,
        data: await service.refresh(refreshOptions),
        publicAccess,
        sessionExpiresAt: req.aiDashboardSession
          ? new Date(req.aiDashboardSession.expiresAt).toISOString()
          : null,
      });
    } catch (error) {
      console.error('[ai-dashboard] refresh error:', error);
      return jsonError(res, 500, 'AI_DASHBOARD_REFRESH_FAILED', 'AI 看板数据刷新失败');
    }
  });

  const requireLocalWriter = (req, res, next) => {
    if (isLocalWriter(req)) return next();
    return jsonError(res, 403, 'ICE_CDS_LOCAL_WRITER_REQUIRED', 'ICE CDS 导入只允许从服务器本机操作');
  };

  router.post('/cds/import/preview', requireLocalWriter, async (req, res) => {
    const validationError = validateCdsImportBody(req.body);
    if (validationError) return jsonError(res, validationError.status, validationError.code, validationError.message);
    try {
      return res.json({ success: true, data: await cdsPipeline.preview(req.body) });
    } catch (error) {
      if (isExpectedCdsInputError(error)) return jsonError(res, 400, error.code || 'ICE_CDS_PREVIEW_REJECTED', error.message);
      console.error('[ai-dashboard] ICE CDS preview error:', error);
      return jsonError(res, 500, 'ICE_CDS_PREVIEW_FAILED', 'ICE CDS 预览失败');
    }
  });

  router.post('/cds/import', requireLocalWriter, async (req, res) => {
    const validationError = validateCdsImportBody(req.body);
    if (validationError) return jsonError(res, validationError.status, validationError.code, validationError.message);
    try {
      return res.json({ success: true, data: await cdsPipeline.import(req.body) });
    } catch (error) {
      if (isExpectedCdsInputError(error)) return jsonError(res, 400, error.code || 'ICE_CDS_IMPORT_REJECTED', error.message);
      console.error('[ai-dashboard] ICE CDS import error:', error);
      return jsonError(res, 500, 'ICE_CDS_IMPORT_FAILED', 'ICE CDS 导入失败，已保留上一版数据');
    }
  });

  router.get('/cds/import-status', async (req, res) => {
    try {
      const status = await cdsPipeline.status();
      return res.json({
        success: true,
        data: { ...status, localWriteAllowed: Boolean(status.localWriteAllowed && isLocalWriter(req)) },
      });
    } catch (error) {
      console.error('[ai-dashboard] ICE CDS status error:', error);
      return jsonError(res, 500, 'ICE_CDS_STATUS_FAILED', 'ICE CDS 导入状态读取失败');
    }
  });

  router.get('/cds/export.xlsx', async (_req, res) => {
    try {
      const buffer = await cdsPipeline.exportWorkbook();
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Disposition', 'attachment; filename="ice-cds-history.xlsx"');
      return res.send(buffer);
    } catch (error) {
      if (error?.code === 'workbook-unavailable') {
        return jsonError(res, 404, 'ICE_CDS_WORKBOOK_UNAVAILABLE', error.message);
      }
      console.error('[ai-dashboard] ICE CDS export error:', error);
      return jsonError(res, 500, 'ICE_CDS_EXPORT_FAILED', 'ICE CDS Excel 下载失败');
    }
  });

  return router;
}

export default createAiDashboardRouter();
