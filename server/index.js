import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";
import Database from "better-sqlite3";
import nodemailer from "nodemailer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const SITE_ROOT = path.resolve(process.env.SITE_ROOT || REPO_ROOT);
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(REPO_ROOT, ".data", "chat.sqlite3"));
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = "nana_session";
const MAX_PUBLIC_RECIPIENTS = 100;
const MAX_PRIVATE_GROUP_MEMBERS = 31; // includes the creator
const MAX_MESSAGE_BYTES = 32 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

if (!process.env.AUTH_PEPPER || process.env.AUTH_PEPPER === "replace-with-a-long-random-secret" || Buffer.byteLength(process.env.AUTH_PEPPER) < 32) {
  console.error("Missing AUTH_PEPPER. Set it in .env (for example: openssl rand -base64 48). The server will not start without it.");
  process.exit(1);
}
const AUTH_PEPPER = process.env.AUTH_PEPPER;
const app = express();
app.disable("x-powered-by");
const proxyHops = process.env.TRUST_PROXY_HOPS;
if (proxyHops) app.set("trust proxy", Number.isFinite(Number(proxyHops)) ? Number(proxyHops) : proxyHops);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new Database(DB_PATH);
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* Some filesystems ignore POSIX permissions. */ }
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    encryption_key TEXT,
    signing_key TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS otp_send_history (
    email_tag TEXT NOT NULL,
    requested_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS otp_send_history_lookup ON otp_send_history(email_tag, requested_at);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('public', 'dm', 'group')),
    name TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS room_members_user ON room_members(user_id, room_id);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    envelopes_json TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_room_cursor ON messages(room_id, created_at, id);
`);
db.prepare("INSERT OR IGNORE INTO rooms (id, type, name, created_by, created_at) VALUES (?, 'public', ?, NULL, ?)")
  .run("village-square", "Village Square — Everyone", Date.now());

const statements = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)"),
  setKeys: db.prepare("UPDATE users SET encryption_key = ?, signing_key = ? WHERE id = ? AND encryption_key IS NULL AND signing_key IS NULL"),
  updateDisplayName: db.prepare("UPDATE users SET display_name = ? WHERE id = ?"),
  loginCode: db.prepare("SELECT * FROM login_codes WHERE email = ?"),
  saveLoginCode: db.prepare("INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, created_at=excluded.created_at"),
  deleteLoginCode: db.prepare("DELETE FROM login_codes WHERE email = ?"),
  incrementAttempts: db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?"),
  session: db.prepare("SELECT s.token_hash, s.user_id, s.expires_at, u.email, u.display_name, u.encryption_key, u.signing_key FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash = ?"),
  insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
  directory: db.prepare("SELECT id, display_name, encryption_key, signing_key, created_at FROM users WHERE encryption_key IS NOT NULL AND signing_key IS NOT NULL ORDER BY display_name COLLATE NOCASE, id LIMIT ?"),
  publicKeyCount: db.prepare("SELECT COUNT(*) AS count FROM users WHERE encryption_key IS NOT NULL AND signing_key IS NOT NULL"),
  otpSendCount: db.prepare("SELECT COUNT(*) AS count FROM otp_send_history WHERE email_tag = ? AND requested_at >= ?"),
  otpSendLatest: db.prepare("SELECT MAX(requested_at) AS latest FROM otp_send_history WHERE email_tag = ?"),
  recordOtpSend: db.prepare("INSERT INTO otp_send_history (email_tag, requested_at) VALUES (?, ?)"),
  messageCountSince: db.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender_id = ? AND created_at >= ?"),
  messageOldestSince: db.prepare("SELECT MIN(created_at) AS oldest FROM messages WHERE sender_id = ? AND created_at >= ?"),
  roomById: db.prepare("SELECT * FROM rooms WHERE id = ?"),
  roomMembers: db.prepare("SELECT u.id, u.display_name, u.encryption_key, u.signing_key FROM room_members rm JOIN users u ON u.id=rm.user_id WHERE rm.room_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id"),
  listRooms: db.prepare(`SELECT r.* FROM rooms r WHERE r.type='public' OR EXISTS (SELECT 1 FROM room_members rm WHERE rm.room_id=r.id AND rm.user_id=?) ORDER BY CASE WHEN r.type='public' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 150`),
  isRoomMember: db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?"),
  dmRoom: db.prepare(`SELECT r.id FROM rooms r JOIN room_members me ON me.room_id=r.id AND me.user_id=? JOIN room_members other ON other.room_id=r.id AND other.user_id=? WHERE r.type='dm' LIMIT 1`),
  insertRoom: db.prepare("INSERT INTO rooms (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)"),
  insertRoomMember: db.prepare("INSERT INTO room_members (room_id, user_id, joined_at, role) VALUES (?, ?, ?, ?)")
};

const mailer = (() => {
  if (!process.env.SMTP_HOST || !process.env.MAIL_FROM) return null;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? "true" : "false")).toLowerCase() === "true";
  const options = {
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  };
  if (process.env.SMTP_USER || process.env.SMTP_PASS) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) throw new Error("Set both SMTP_USER and SMTP_PASS, or neither.");
    options.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  }
  return nodemailer.createTransport(options);
})();
if (!mailer) console.warn("Email is not configured. Passwordless login endpoints will return 503 until SMTP_HOST and MAIL_FROM are set.");

// Small per-process rolling-window limiter. Put a reverse-proxy/WAF limit in front too.
const buckets = new Map();
function clientIp(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 100);
  return ip;
}
function rateLimit({ name, limit, windowMs, key = clientIp, message = "Too many requests. Please wait and try again." }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${name}:${String(key(req)).slice(0, 320)}`;
    const previous = buckets.get(bucketKey) || [];
    const fresh = previous.filter(time => time > now - windowMs);
    if (fresh.length >= limit) {
      buckets.set(bucketKey, fresh);
      const retryMs = Math.max(1000, fresh[0] + windowMs - now);
      res.setHeader("Retry-After", String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({ error: message, retryAfter: Math.ceil(retryMs / 1000) });
    }
    fresh.push(now);
    buckets.set(bucketKey, fresh);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of buckets) {
    const fresh = times.filter(t => t > now - 60 * 60 * 1000);
    if (fresh.length) buckets.set(key, fresh); else buckets.delete(key);
  }
  statements.deleteExpiredSessions.run(now);
  db.prepare("DELETE FROM login_codes WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM otp_send_history WHERE requested_at < ?").run(now - 25 * 60 * 60 * 1000);
}, 5 * 60 * 1000).unref();

const emailRequestIpLimit = rateLimit({ name: "otp-request-ip", limit: 4, windowMs: 15 * 60 * 1000, message: "Too many login-code requests from this network. Wait a little and try again." });
const emailRequestAddressLimit = rateLimit({ name: "otp-request-email", limit: 3, windowMs: 60 * 60 * 1000, key: req => normalizeEmail(req.body?.email) || "invalid", message: "Too many codes were requested for this address. Try again later." });
const emailVerifyIpLimit = rateLimit({ name: "otp-verify-ip", limit: 12, windowMs: 15 * 60 * 1000, message: "Too many verification attempts from this network. Try again later." });
const emailVerifyAddressLimit = rateLimit({ name: "otp-verify-email", limit: 10, windowMs: 15 * 60 * 1000, key: req => normalizeEmail(req.body?.email) || "invalid", message: "Too many verification attempts for this address. Request a new code later." });
const chatSendIpLimit = rateLimit({ name: "chat-send-ip", limit: 40, windowMs: 60 * 1000, message: "This network is sending messages too quickly. Wait a moment." });
const chatSendUserLimit = rateLimit({ name: "chat-send-user-minute", limit: 12, windowMs: 60 * 1000, key: req => req.auth?.id || clientIp(req), message: "Message limit reached (12 per minute). Wait a moment before sending again." });
const chatSendHourlyLimit = rateLimit({ name: "chat-send-user-hour", limit: 120, windowMs: 60 * 60 * 1000, key: req => req.auth?.id || clientIp(req), message: "Message limit reached (120 per hour). Please take a break and try again later." });
const readMessagesLimit = rateLimit({ name: "chat-read-user", limit: 90, windowMs: 60 * 1000, key: req => req.auth?.id || clientIp(req), message: "Chat is refreshing too quickly. Wait a moment." });
const createRoomLimit = rateLimit({ name: "room-create-user", limit: 5, windowMs: 60 * 60 * 1000, key: req => req.auth?.id || clientIp(req), message: "Room creation limit reached (5 per hour)." });
const profileUpdateLimit = rateLimit({ name: "profile-update-user", limit: 5, windowMs: 60 * 60 * 1000, key: req => req.auth?.id || clientIp(req), message: "Display-name changes are limited to 5 per hour." });

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email) || /\.\./.test(email)) return "";
  return email;
}
function codeMac(email, code) {
  return crypto.createHmac("sha256", AUTH_PEPPER).update(`${email}\0${code}`).digest();
}
function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function safeString(value, max) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function decodeCanonicalBase64(value, label, maxBytes = 8192) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 4 || !BASE64_RE.test(value) || value.length % 4 !== 0) throw new HttpError(400, `${label} is not valid base64.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== value) throw new HttpError(400, `${label} is too large or invalid.`);
  return bytes;
}
function validateEncryptionSpki(value) {
  const der = decodeCanonicalBase64(value, "Encryption public key", 8192);
  let key;
  try { key = crypto.createPublicKey({ key: der, format: "der", type: "spki" }); } catch { throw new HttpError(400, "Encryption public key is invalid."); }
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== "rsa" || !Number.isInteger(details.modulusLength) || details.modulusLength < 3072 || details.modulusLength > 4096 || details.publicExponent !== 65537n) {
    throw new HttpError(400, "Encryption keys must be RSA 3072–4096 with exponent 65537.");
  }
  return der.toString("base64");
}
function validateSigningSpki(value) {
  const der = decodeCanonicalBase64(value, "Signing public key", 8192);
  let key;
  try { key = crypto.createPublicKey({ key: der, format: "der", type: "spki" }); } catch { throw new HttpError(400, "Signing public key is invalid."); }
  const details = key.asymmetricKeyDetails || {};
  if (key.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") throw new HttpError(400, "Signing keys must use ECDSA P-256.");
  return der.toString("base64");
}
function defaultDisplayName(userId) {
  // Do not expose an email local-part as a public chat name by default.
  return `Baker ${userId.slice(0, 4).toUpperCase()}`;
}
function publicUser(row) {
  return { id: row.id, displayName: row.display_name, encryptionKey: row.encryption_key || null, signingKey: row.signing_key || null };
}
function userForMe(row) {
  return { id: row.id, email: row.email, displayName: row.display_name, encryptionKey: row.encryption_key || null, signingKey: row.signing_key || null };
}
function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return next(); // Non-browser clients may omit Origin; cookie policy still applies to browsers.
  let parsed;
  try { parsed = new URL(origin); } catch { return res.status(403).json({ error: "Invalid request origin." }); }
  const expectedProtocol = req.protocol;
  if (parsed.host.toLowerCase() !== String(req.get("host") || "").toLowerCase() || parsed.protocol !== `${expectedProtocol}:`) {
    return res.status(403).json({ error: "Cross-origin requests are not accepted." });
  }
  next();
}
function readSessionCookie(req) {
  const cookieHeader = req.headers.cookie || "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) return part.slice(separator + 1).trim();
  }
  return "";
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: IS_PRODUCTION, sameSite: "strict", path: "/api" });
}
function requireSession(req, res, next) {
  const rawToken = readSessionCookie(req);
  if (!rawToken || !/^[A-Za-z0-9_-]{40,100}$/.test(rawToken)) return res.status(401).json({ error: "Please sign in with an email code." });
  const tokenHash = hashToken(rawToken);
  const session = statements.session.get(tokenHash);
  if (!session || session.expires_at <= Date.now()) {
    if (session) statements.deleteSession.run(tokenHash);
    clearSessionCookie(res);
    return res.status(401).json({ error: "Your session has expired. Sign in again." });
  }
  req.auth = { id: session.user_id, email: session.email, displayName: session.display_name, encryptionKey: session.encryption_key, signingKey: session.signing_key, tokenHash };
  next();
}
function requireKeys(req, res, next) {
  if (!req.auth?.encryptionKey || !req.auth?.signingKey) return res.status(409).json({ error: "Set up or restore this account's encryption keys before using chat.", code: "KEYS_NOT_REGISTERED" });
  next();
}
function canAccessRoom(room, userId) {
  return room?.type === "public" || Boolean(statements.isRoomMember.get(room.id, userId));
}
function getRoomOr404(roomId) {
  if (typeof roomId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(roomId)) throw new HttpError(404, "Room not found.");
  const room = statements.roomById.get(roomId);
  if (!room) throw new HttpError(404, "Room not found.");
  return room;
}
function requireRoomAccess(room, userId) {
  if (!canAccessRoom(room, userId)) throw new HttpError(404, "Room not found.");
}
function roomMemberSummaries(roomId) {
  return statements.roomMembers.all(roomId).map(u => ({ id: u.id, displayName: u.display_name }));
}
function summarizeRoom(room, userId) {
  const members = roomMemberSummaries(room.id);
  let name = room.name;
  if (room.type === "dm") name = members.find(m => m.id !== userId)?.displayName || "Direct message";
  return { id: room.id, type: room.type, name, createdAt: room.created_at, memberCount: room.type === "public" ? statements.publicKeyCount.get().count : members.length, members };
}
function cursorInt(value, name) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, `${name} is invalid.`);
  return parsed;
}
class HttpError extends Error {
  constructor(status, message, code = undefined) { super(message); this.status = status; this.code = code; }
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (IS_PRODUCTION) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'"
  ].join("; ") + (IS_PRODUCTION ? "; upgrade-insecure-requests" : ""));
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store, max-age=0");
  next();
});
app.use(express.json({ limit: "512kb", strict: true, type: "application/json" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") return requireSameOrigin(req, res, next);
  next();
});

app.get("/api/status", (req, res) => res.json({ ok: true, service: "nana-bake-a-message", emailConfigured: Boolean(mailer) }));

app.post("/api/auth/request-code", emailRequestIpLimit, emailRequestAddressLimit, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "Enter a valid email address." });
  if (!mailer) return res.status(503).json({ error: "Passwordless email login is not configured on this server yet." });

  const now = Date.now();
  const emailTag = crypto.createHmac("sha256", AUTH_PEPPER).update(`otp:${email}`).digest("hex");
  const latestSent = statements.otpSendLatest.get(emailTag)?.latest;
  if (latestSent && now - latestSent < 60 * 1000) {
    const retryAfter = Math.max(1, Math.ceil((latestSent + 60 * 1000 - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Please wait before requesting another code.", retryAfter });
  }
  if (statements.otpSendCount.get(emailTag, now - 60 * 60 * 1000).count >= 3) {
    res.setHeader("Retry-After", "3600");
    return res.status(429).json({ error: "Too many codes were requested for this address. Try again later.", retryAfter: 3600 });
  }
  // Store only a keyed email tag in rate history; this also survives server restarts.
  statements.recordOtpSend.run(emailTag, now);
  const code = String(crypto.randomInt(100000, 1000000));
  statements.saveLoginCode.run(email, codeMac(email, code).toString("hex"), now + OTP_TTL_MS, now);
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "Your Nana Julian's Bake A Message sign-in code",
      text: `Your sign-in code is ${code}.\n\nIt expires in 10 minutes and can be used once. If you did not request it, ignore this email.\n\nNana Julian's Bakery`,
      html: `<div style="font-family:Georgia,serif;color:#33291f"><h2>Nana Julian's Bake A Message</h2><p>Your sign-in code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes and can be used once. If you did not request it, ignore this email.</p></div>`
    });
  } catch (error) {
    statements.deleteLoginCode.run(email);
    console.error("OTP email delivery failed:", error?.code || error?.name || "mail error");
    return res.status(503).json({ error: "The email service could not send your code. Please try again later." });
  }
  return res.json({ ok: true, message: "If this address can receive mail, a sign-in code has been sent. Check your inbox and spam folder." });
});

app.post("/api/auth/verify-code", emailVerifyIpLimit, emailVerifyAddressLimit, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = safeString(req.body?.code, 20);
  if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter the email address and its six-digit code." });
  const challenge = statements.loginCode.get(email);
  const now = Date.now();
  if (!challenge || challenge.expires_at <= now || challenge.attempts >= 5) {
    if (challenge && (challenge.expires_at <= now || challenge.attempts >= 5)) statements.deleteLoginCode.run(email);
    return res.status(400).json({ error: "That code is invalid or expired. Request a new one." });
  }
  const provided = codeMac(email, code);
  const expected = Buffer.from(challenge.code_hash, "hex");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    statements.incrementAttempts.run(email);
    return res.status(400).json({ error: "That code is invalid or expired. Request a new one." });
  }
  statements.deleteLoginCode.run(email);
  let user = statements.userByEmail.get(email);
  if (!user) {
    const id = crypto.randomUUID();
    statements.insertUser.run(id, email, defaultDisplayName(id), now);
    user = statements.userById.get(id);
  }
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  const tokenHash = hashToken(rawToken);
  statements.insertSession.run(tokenHash, user.id, expiresAt, now);
  res.cookie(SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "strict",
    path: "/api",
    maxAge: SESSION_TTL_MS,
    priority: "high"
  });
  return res.json({ ok: true, user: userForMe(user), expiresAt });
});

app.post("/api/auth/logout", requireSameOrigin, requireSession, (req, res) => {
  statements.deleteSession.run(req.auth.tokenHash);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireSession, (req, res) => {
  res.json({ user: { id: req.auth.id, email: req.auth.email, displayName: req.auth.displayName, encryptionKey: req.auth.encryptionKey || null, signingKey: req.auth.signingKey || null } });
});

app.patch("/api/me/profile", requireSession, profileUpdateLimit, (req, res) => {
  const name = safeString(req.body?.displayName, 32).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name || [...name].length > 32) throw new HttpError(400, "Display name must be between 1 and 32 characters.");
  statements.updateDisplayName.run(name, req.auth.id);
  const updated = statements.userById.get(req.auth.id);
  res.json({ ok: true, user: userForMe(updated) });
});

app.put("/api/me/keys", requireSession, (req, res) => {
  const encryptionKey = validateEncryptionSpki(req.body?.encryptionKey);
  const signingKey = validateSigningSpki(req.body?.signingKey);
  const current = statements.userById.get(req.auth.id);
  if (current.encryption_key || current.signing_key) {
    if (current.encryption_key === encryptionKey && current.signing_key === signingKey) return res.json({ ok: true, user: userForMe(current) });
    return res.status(409).json({ error: "Keys already exist for this account. Restore them with the recovery file instead of replacing them.", code: "KEYS_ALREADY_SET" });
  }
  statements.setKeys.run(encryptionKey, signingKey, req.auth.id);
  const updated = statements.userById.get(req.auth.id);
  if (updated.encryption_key !== encryptionKey || updated.signing_key !== signingKey) {
    return res.status(409).json({ error: "Encryption keys were registered in another tab. Sign in again and restore the registered keys if needed.", code: "KEYS_ALREADY_SET" });
  }
  return res.json({ ok: true, user: userForMe(updated) });
});

app.get("/api/directory", requireSession, requireKeys, (req, res) => {
  const count = statements.publicKeyCount.get().count;
  if (count > MAX_PUBLIC_RECIPIENTS) return res.status(503).json({ error: `This prototype supports up to ${MAX_PUBLIC_RECIPIENTS} keyed users in the public room.` });
  const users = statements.directory.all(MAX_PUBLIC_RECIPIENTS + 1).map(publicUser);
  res.json({ users });
});

app.get("/api/rooms", requireSession, requireKeys, (req, res) => {
  const rooms = statements.listRooms.all(req.auth.id).map(room => summarizeRoom(room, req.auth.id));
  res.json({ rooms });
});

app.post("/api/rooms", requireSession, requireKeys, createRoomLimit, (req, res) => {
  const type = req.body?.type;
  if (type !== "dm" && type !== "group") throw new HttpError(400, "Room type must be dm or group.");
  const rawMembers = req.body?.memberIds;
  if (!Array.isArray(rawMembers) || rawMembers.length > MAX_PRIVATE_GROUP_MEMBERS) throw new HttpError(400, "Choose valid room members.");
  const memberIds = [...new Set(rawMembers.filter(id => typeof id === "string" && UUID_RE.test(id) && id !== req.auth.id))];
  if (type === "dm" && memberIds.length !== 1) throw new HttpError(400, "A direct message must have exactly one other person.");
  if (type === "group" && memberIds.length < 1) throw new HttpError(400, "Choose at least one other baker for a group.");
  if (memberIds.length + 1 > MAX_PRIVATE_GROUP_MEMBERS) throw new HttpError(400, `Private groups support up to ${MAX_PRIVATE_GROUP_MEMBERS} people.`);

  const placeholders = memberIds.map(() => "?").join(",");
  const recipients = db.prepare(`SELECT id, encryption_key, signing_key FROM users WHERE id IN (${placeholders})`).all(...memberIds);
  if (recipients.length !== memberIds.length || recipients.some(user => !user.encryption_key || !user.signing_key)) throw new HttpError(400, "One selected baker has not finished encryption setup. Refresh the people list and try again.");
  const allIds = [req.auth.id, ...memberIds];
  if (type === "dm") {
    const existing = statements.dmRoom.get(req.auth.id, memberIds[0]);
    if (existing) return res.json({ room: summarizeRoom(statements.roomById.get(existing.id), req.auth.id), existing: true });
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  const name = type === "group" ? safeString(req.body?.name, 48).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : null;
  if (type === "group" && !name) throw new HttpError(400, "Enter a group name.");
  const transaction = db.transaction(() => {
    statements.insertRoom.run(id, type, name, req.auth.id, now);
    allIds.forEach((memberId, index) => statements.insertRoomMember.run(id, memberId, now, index === 0 ? "owner" : "member"));
  });
  transaction();
  res.status(201).json({ room: summarizeRoom(statements.roomById.get(id), req.auth.id), existing: false });
});

app.get("/api/rooms/:roomId/recipients", requireSession, requireKeys, (req, res) => {
  const room = getRoomOr404(req.params.roomId);
  requireRoomAccess(room, req.auth.id);
  let users;
  if (room.type === "public") {
    const count = statements.publicKeyCount.get().count;
    if (count > MAX_PUBLIC_RECIPIENTS) throw new HttpError(503, `The public room supports up to ${MAX_PUBLIC_RECIPIENTS} participants in this prototype.`);
    users = statements.directory.all(MAX_PUBLIC_RECIPIENTS + 1).map(publicUser);
  } else {
    users = statements.roomMembers.all(room.id).map(publicUser);
  }
  res.json({ users });
});

app.get("/api/rooms/:roomId/messages", requireSession, requireKeys, readMessagesLimit, (req, res) => {
  const room = getRoomOr404(req.params.roomId);
  requireRoomAccess(room, req.auth.id);
  const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || "50", 10) || 50));
  const afterTime = cursorInt(req.query.afterTime, "afterTime");
  const beforeTime = cursorInt(req.query.beforeTime, "beforeTime");
  const afterId = safeString(req.query.afterId, 80);
  const beforeId = safeString(req.query.beforeId, 80);
  if (afterTime !== null && !UUID_RE.test(afterId)) throw new HttpError(400, "afterId is required with afterTime.");
  if (beforeTime !== null && !UUID_RE.test(beforeId)) throw new HttpError(400, "beforeId is required with beforeTime.");
  if (afterTime !== null && beforeTime !== null) throw new HttpError(400, "Use either an after or before cursor.");
  let rows;
  let olderCursor = null;
  let hasOlder = false;
  if (afterTime !== null) {
    rows = db.prepare(`SELECT m.*, u.display_name AS sender_name, u.encryption_key AS sender_encryption_key, u.signing_key AS sender_signing_key FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.room_id=? AND (m.created_at>? OR (m.created_at=? AND m.id>?)) ORDER BY m.created_at ASC, m.id ASC LIMIT ?`)
      .all(room.id, afterTime, afterTime, afterId, limit);
  } else if (beforeTime !== null) {
    rows = db.prepare(`SELECT m.*, u.display_name AS sender_name, u.encryption_key AS sender_encryption_key, u.signing_key AS sender_signing_key FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.room_id=? AND (m.created_at<? OR (m.created_at=? AND m.id<?)) ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
      .all(room.id, beforeTime, beforeTime, beforeId, limit + 1);
    hasOlder = rows.length > limit;
    if (hasOlder) rows.pop();
    rows.reverse();
  } else {
    rows = db.prepare(`SELECT m.*, u.display_name AS sender_name, u.encryption_key AS sender_encryption_key, u.signing_key AS sender_signing_key FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.room_id=? ORDER BY m.created_at DESC, m.id DESC LIMIT ?`)
      .all(room.id, limit + 1);
    hasOlder = rows.length > limit;
    if (hasOlder) rows.pop();
    rows.reverse();
  }
  if (rows.length) olderCursor = { time: rows[0].created_at, id: rows[0].id };
  const messages = rows.map(row => ({
    id: row.id, roomId: row.room_id, senderId: row.sender_id, senderName: row.sender_name,
    senderEncryptionKey: row.sender_encryption_key, senderSigningKey: row.sender_signing_key,
    iv: row.iv, ciphertext: row.ciphertext, envelopes: JSON.parse(row.envelopes_json), signature: row.signature, createdAt: row.created_at
  }));
  res.json({ messages, olderCursor, hasOlder });
});

app.post("/api/rooms/:roomId/messages", requireSession, requireKeys, chatSendIpLimit, chatSendUserLimit, chatSendHourlyLimit, async (req, res) => {
  const room = getRoomOr404(req.params.roomId);
  requireRoomAccess(room, req.auth.id);
  const id = safeString(req.body?.id, 80);
  const senderId = safeString(req.body?.senderId, 80);
  const roomId = room.id;
  if (!UUID_RE.test(id)) throw new HttpError(400, "Message ID is invalid.");
  if (senderId !== req.auth.id) throw new HttpError(400, "Message sender does not match the signed-in user.");
  if (statements.userById.get(req.auth.id).encryption_key !== req.auth.encryptionKey) throw new HttpError(409, "Account keys changed; reload and verify your local keys.");
  const ivBytes = decodeCanonicalBase64(req.body?.iv, "Message IV", 12);
  if (ivBytes.length !== 12) throw new HttpError(400, "Message IV must be 12 bytes.");
  const ciphertextBytes = decodeCanonicalBase64(req.body?.ciphertext, "Message ciphertext", MAX_MESSAGE_BYTES);
  if (ciphertextBytes.length < 17) throw new HttpError(400, "Message ciphertext is too short.");
  const signatureBytes = decodeCanonicalBase64(req.body?.signature, "Message signature", 128);
  if (signatureBytes.length !== 64) throw new HttpError(400, "Message signature must be a P-256 signature.");
  const envelopes = req.body?.envelopes;
  if (!envelopes || typeof envelopes !== "object" || Array.isArray(envelopes)) throw new HttpError(400, "Message key envelopes are missing.");
  const recipientIds = Object.keys(envelopes);
  if (!recipientIds.length || recipientIds.length > MAX_PUBLIC_RECIPIENTS) throw new HttpError(400, "Invalid recipient count.");
  if (!recipientIds.includes(req.auth.id)) throw new HttpError(400, "Your own encrypted message copy is missing.");

  let allowedUsers;
  if (room.type === "public") {
    const count = statements.publicKeyCount.get().count;
    if (count > MAX_PUBLIC_RECIPIENTS) throw new HttpError(503, `The public room supports up to ${MAX_PUBLIC_RECIPIENTS} participants in this prototype.`);
    allowedUsers = statements.directory.all(MAX_PUBLIC_RECIPIENTS + 1);
  } else {
    allowedUsers = statements.roomMembers.all(room.id);
  }
  const allowed = new Map(allowedUsers.filter(u => u.encryption_key && u.signing_key).map(u => [u.id, u]));
  if (room.type === "group" || room.type === "dm") {
    const expectedIds = [...allowed.keys()].sort();
    const actualIds = [...recipientIds].sort();
    if (expectedIds.length !== actualIds.length || expectedIds.some((value, index) => value !== actualIds[index])) {
      throw new HttpError(409, "The recipient list changed. Refresh the room and send again.", "RECIPIENT_LIST_CHANGED");
    }
  } else {
    if (recipientIds.some(id => !allowed.has(id))) throw new HttpError(400, "The public-room message contains an unknown recipient.");
    if (recipientIds.length !== allowed.size) throw new HttpError(409, "The village membership changed while encrypting. Send again to include everyone.", "RECIPIENT_LIST_CHANGED");
  }
  const envelopesSafe = Object.create(null);
  for (const userId of recipientIds) {
    if (!UUID_RE.test(userId) || !allowed.has(userId)) throw new HttpError(400, "An encrypted recipient is not allowed in this room.");
    const wrapped = decodeCanonicalBase64(envelopes[userId], "Encrypted message key", 512);
    const publicKey = crypto.createPublicKey({ key: Buffer.from(allowed.get(userId).encryption_key, "base64"), format: "der", type: "spki" });
    const expectedLength = Math.ceil((publicKey.asymmetricKeyDetails?.modulusLength || 3072) / 8);
    if (wrapped.length !== expectedLength) throw new HttpError(400, "An encrypted message key has the wrong size.");
    envelopesSafe[userId] = wrapped.toString("base64");
  }
  const signedPayload = JSON.stringify([1, id, roomId, senderId, req.body.iv, req.body.ciphertext, Object.keys(envelopesSafe).sort().map(userId => [userId, envelopesSafe[userId]])]);
  let signatureOkay = false;
  try {
    const signingPublicKey = await crypto.webcrypto.subtle.importKey("spki", Buffer.from(req.auth.signingKey, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    signatureOkay = await crypto.webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signingPublicKey, signatureBytes, new TextEncoder().encode(signedPayload));
  } catch { signatureOkay = false; }
  if (!signatureOkay) throw new HttpError(400, "The message signature is invalid. Nothing was saved.");

  // Re-check the global recipient set after asynchronous signature verification so a just-registered account is not silently missed.
  if (room.type === "public") {
    const currentCount = statements.publicKeyCount.get().count;
    if (currentCount > MAX_PUBLIC_RECIPIENTS) throw new HttpError(503, `The public room supports up to ${MAX_PUBLIC_RECIPIENTS} participants in this prototype.`);
    const currentIds = statements.directory.all(MAX_PUBLIC_RECIPIENTS + 1).map(user => user.id).sort();
    const messageIds = Object.keys(envelopesSafe).sort();
    if (currentIds.length !== messageIds.length || currentIds.some((value, index) => value !== messageIds[index])) {
      throw new HttpError(409, "The village membership changed while encrypting. Send again to include everyone.", "RECIPIENT_LIST_CHANGED");
    }
  }

  // Persistent per-account limits complement the in-memory IP limiter and cannot be reset by a process restart.
  const rateNow = Date.now();
  const minuteWindow = rateNow - 60 * 1000;
  const hourWindow = rateNow - 60 * 60 * 1000;
  const minuteCount = statements.messageCountSince.get(req.auth.id, minuteWindow).count;
  const hourCount = statements.messageCountSince.get(req.auth.id, hourWindow).count;
  if (minuteCount >= 12 || hourCount >= 120) {
    const windowMs = minuteCount >= 12 ? 60 * 1000 : 60 * 60 * 1000;
    const oldest = statements.messageOldestSince.get(req.auth.id, rateNow - windowMs)?.oldest || rateNow;
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - rateNow) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: minuteCount >= 12 ? "Message limit reached (12 per minute). Wait before sending again." : "Message limit reached (120 per hour). Wait before sending again.", retryAfter });
  }
  const previousTime = db.prepare("SELECT MAX(created_at) AS last_time FROM messages WHERE room_id = ?").get(roomId)?.last_time || 0;
  const createdAt = Math.max(Date.now(), previousTime + 1); // monotonic per room, so polling cursors cannot skip same-millisecond posts.
  try {
    db.prepare("INSERT INTO messages (id, room_id, sender_id, iv, ciphertext, envelopes_json, signature, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, roomId, req.auth.id, req.body.iv, req.body.ciphertext, JSON.stringify(envelopesSafe), req.body.signature, createdAt);
  } catch (error) {
    if (String(error?.code || "").includes("CONSTRAINT")) throw new HttpError(409, "This message was already sent or the room is no longer available.");
    throw error;
  }
  res.status(201).json({ ok: true, id });
});

// Keep implementation files and state out of the website's static URL space.
app.use((req, res, next) => {
  if (/^\/(?:server|node_modules|tests|\.data)(?:\/|$)/.test(req.path) || ["/package.json", "/package-lock.json", "/.env", "/.env.example", "/CHAT_SETUP.md", "/GITIGNORE_CHAT_ADDITIONS.txt", "/README.txt"].includes(req.path)) return res.sendStatus(404);
  next();
});
app.use(express.static(SITE_ROOT, { dotfiles: "deny", extensions: ["html"], maxAge: IS_PRODUCTION ? "1h" : 0 }));
app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((req, res) => res.status(404).type("text").send("Not found"));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) return res.status(400).json({ error: "Request JSON is invalid." });
  if (error?.type === "entity.too.large") return res.status(413).json({ error: "Request is too large." });
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  console.error("Unhandled chat API error:", error?.name || "Error", error?.code || "");
  return res.status(500).json({ error: "An internal server error occurred. No message contents were logged." });
});

const server = app.listen(PORT, () => {
  console.log(`Nana Julian's Bakery web/chat server listening on port ${PORT} (${NODE_ENV}).`);
  console.log(`Website root: ${SITE_ROOT}`);
  console.log(`Chat database: ${DB_PATH}`);
  console.log(`SMTP configured: ${Boolean(mailer)}`);
});
function shutdown() {
  server.close(() => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
