import crypto from 'node:crypto';
import express from 'express';
import { createAiDashboardServiceFromEnv } from '../lib/aiDashboardService.js';

const COOKIE_NAME = 'ai_dashboard_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const REFRESH_SOURCES = new Set(['feishu', 'openRouter', 'benchmarks']);

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

export function createAiDashboardRouter({
  service = createAiDashboardServiceFromEnv(),
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
        '刷新范围必须是 feishu、openRouter 或 benchmarks，force 必须是布尔值',
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

  return router;
}

export default createAiDashboardRouter();
