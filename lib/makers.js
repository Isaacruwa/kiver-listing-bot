// Maker Health & Growth: tells the person who listed a bot when it disappears from Telegram,
// and sends a weekly report. Needs a Postgres database (KIVER_MAKER_DB_URL); without one it stays off.
// Admin chats are never enrolled: bots an admin lists never create alerts or data.
const DAY = 86400000;
const CHECK_EVERY_MS = Math.max(5, Number(process.env.KIVER_HEALTH_INTERVAL_MIN || 20)) * 60000;
const DIGEST_EVERY_MS = Math.max(1, Number(process.env.KIVER_DIGEST_DAYS || 7)) * DAY;
const MISSES_BEFORE_ALERT = 2;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = n => (n == null ? "n/a" : Number(n).toLocaleString("en-US"));
const delta = (now, then) => (now == null || then == null || now === then) ? "" : " (" + (now > then ? "+" : "") + num(now - then) + ")";

module.exports = function createMakerHealth(deps) {
  const { tg, kiver, reply, msgTtlMs, isAdminSession } = deps;
  const url = (process.env.KIVER_MAKER_DB_URL || "").replace(/([?&])channel_binding=[^&]*&?/i, "$1").replace(/[?&]$/, "").replace(/sslmode=(require|prefer|verify-ca)/i, "sslmode=verify-full");
  let pool = null, ready = false, initP = null;
  const whenReady = async () => { if (initP) await initP; return ready; }; // updates queued during a restart can arrive before the database is connected
  const log = (...a) => console.error("[maker-health]", ...a);

  async function q(sql, params) { return pool.query(sql, params); }

  async function init() {
    if (!url) { console.log("Maker health is off (KIVER_MAKER_DB_URL not set)."); return false; }
    try {
      const { Pool } = require("pg");
      pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 20000 });
      pool.on("error", e => log("pool error:", e.message));
      await q(`CREATE TABLE IF NOT EXISTS mh_admins (chat_id BIGINT PRIMARY KEY, added_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS mh_makers (chat_id BIGINT PRIMARY KEY, alerts_on BOOLEAN NOT NULL DEFAULT TRUE, last_digest_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS mh_bots (slug TEXT PRIMARY KEY, username TEXT NOT NULL, name TEXT NOT NULL, owner_chat_id BIGINT NOT NULL REFERENCES mh_makers(chat_id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), status TEXT NOT NULL DEFAULT 'up', misses INT NOT NULL DEFAULT 0, down_since TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, monthly_users BIGINT, base_users BIGINT, base_upvotes INT)`);
      ready = true;
      return true;
    } catch (e) { log("init failed, feature disabled:", e.message); ready = false; return false; }
  }

  async function isAdmin(chatId) {
    if (isAdminSession && isAdminSession(chatId)) return true;
    const r = await q("SELECT 1 FROM mh_admins WHERE chat_id=$1", [chatId]);
    return r.rowCount > 0;
  }

  // Called when an admin proves the admin key: remember them, and drop anything already tracked for that chat.
  async function markAdmin(chatId) {
    if (!(await whenReady())) return;
    try {
      await q("INSERT INTO mh_admins(chat_id) VALUES($1) ON CONFLICT DO NOTHING", [chatId]);
      await q("DELETE FROM mh_makers WHERE chat_id=$1", [chatId]);
    } catch (e) { log("markAdmin:", e.message); }
  }

  // Called after a listing is created. Returns true if the submitter is now tracked.
  async function enroll({ chatId, slug, username, name }) {
    if (!(await whenReady()) || !slug || !username) return false;
    try {
      if (await isAdmin(chatId)) return false;
      await q("INSERT INTO mh_makers(chat_id) VALUES($1) ON CONFLICT DO NOTHING", [chatId]);
      const r = await q("INSERT INTO mh_bots(slug,username,name,owner_chat_id) VALUES($1,$2,$3,$4) ON CONFLICT (slug) DO NOTHING", [slug, String(username), String(name || username), chatId]);
      return r.rowCount > 0;
    } catch (e) { log("enroll:", e.message); return false; }
  }

  // ---- Telegram page probe ------------------------------------------------
  async function probe(username) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch("https://t.me/" + encodeURIComponent(username), { headers: { "user-agent": "KiverListingBot/1.0" }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return { state: "error" };
      const h = await r.text();
      const title = (/<meta[^>]+property=["']og:title["'][^>]*content="([^"]*)"/i.exec(h) || [])[1] || "";
      if (!title || /^telegram:\s*contact\s*@/i.test(title)) return { state: "missing" };
      const m = /tgme_page_extra">([\d\s\u00a0\u202f,.]+)\s*monthly users/i.exec(h);
      return { state: "ok", users: m ? Number(m[1].replace(/\D/g, "")) : null };
    } catch (_) { return { state: "error" }; }
  }

  // Alerts are permanent messages (they must not self-destruct).
  async function dm(chatId, text) {
    try { await tg("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }); return true; }
    catch (e) {
      if (/blocked|deactivated|chat not found|forbidden/i.test(String(e.message))) await q("UPDATE mh_makers SET alerts_on=FALSE WHERE chat_id=$1", [chatId]).catch(() => {});
      log("dm failed:", e.message); return false;
    }
  }

  async function checkOne(b) {
    const p = await probe(b.username);
    if (p.state === "error") { await q("UPDATE mh_bots SET last_checked_at=now() WHERE slug=$1", [b.slug]); return; }
    if (p.state === "ok") {
      const wasDown = b.status === "down";
      await q("UPDATE mh_bots SET status='up', misses=0, down_since=NULL, last_checked_at=now(), monthly_users=COALESCE($2,monthly_users) WHERE slug=$1", [b.slug, p.users]);
      if (wasDown && b.alerts_on) await dm(b.owner_chat_id, "✅ " + b.name + " (@" + b.username + ") is back on Telegram.\n\nIts public page is reachable again.\nhttps://getkiver.com/bot/" + b.slug);
      return;
    }
    const misses = b.misses + 1;
    if (misses >= MISSES_BEFORE_ALERT && b.status === "up") {
      await q("UPDATE mh_bots SET status='down', misses=$2, down_since=now(), last_checked_at=now() WHERE slug=$1", [b.slug, misses]);
      if (b.alerts_on) await dm(b.owner_chat_id, "⚠️ " + b.name + " (@" + b.username + ") looks removed from Telegram.\n\nIts public Telegram page can't be found, so it may have been deleted, banned or renamed. I'll keep checking and tell you if it comes back.\n\nYour Kiver page: https://getkiver.com/bot/" + b.slug + "\n\nSend /alerts off to stop these messages.");
    } else await q("UPDATE mh_bots SET misses=$2, last_checked_at=now() WHERE slug=$1", [b.slug, misses]);
  }

  let checking = false;
  async function checkAll() {
    if (!ready || checking) return;
    checking = true;
    try {
      const { rows } = await q("SELECT b.*, m.alerts_on FROM mh_bots b JOIN mh_makers m ON m.chat_id=b.owner_chat_id ORDER BY b.last_checked_at ASC NULLS FIRST LIMIT 60");
      for (const b of rows) { try { await checkOne(b); } catch (e) { log("check", b.slug, e.message); } await sleep(1500); }
    } catch (e) { log("checkAll:", e.message); } finally { checking = false; }
  }

  async function upvotes(b) {
    try { const rows = await kiver("list", { q: b.username, limit: 5, offset: 0, sort: "top" }); const x = (rows || []).find(r => r.slug === b.slug); return x ? Number(x.upvotes) || 0 : null; } catch (_) { return null; }
  }

  async function digestFor(chatId, advance) {
    const { rows } = await q("SELECT * FROM mh_bots WHERE owner_chat_id=$1 ORDER BY created_at ASC LIMIT 12", [chatId]);
    if (!rows.length) return null;
    const lines = [];
    for (const b of rows) {
      const up = await upvotes(b);
      lines.push("• " + b.name + " (@" + b.username + ")\n  " + (b.status === "down" ? "⚠️ not found on Telegram right now\n  " : "") + "Upvotes: " + num(up) + delta(up, b.base_upvotes) + "\n  Monthly users: " + num(b.monthly_users) + delta(b.monthly_users == null ? null : Number(b.monthly_users), b.base_users == null ? null : Number(b.base_users)) + "\n  https://getkiver.com/bot/" + b.slug);
      if (advance) await q("UPDATE mh_bots SET base_users=monthly_users, base_upvotes=COALESCE($2,base_upvotes) WHERE slug=$1", [b.slug, up]);
    }
    return lines.join("\n\n");
  }

  async function sendDigests() {
    if (!ready) return;
    try {
      const { rows } = await q("SELECT chat_id FROM mh_makers WHERE alerts_on AND last_digest_at <= now() - ($1 || ' milliseconds')::interval LIMIT 50", [String(DIGEST_EVERY_MS)]);
      for (const m of rows) {
        const body = await digestFor(m.chat_id, true);
        await q("UPDATE mh_makers SET last_digest_at=now() WHERE chat_id=$1", [m.chat_id]);
        if (body) await dm(m.chat_id, "📊 Your weekly Kiver report\n\n" + body + "\n\nSend /alerts off to stop these messages.");
        await sleep(1000);
      }
    } catch (e) { log("sendDigests:", e.message); }
  }

  // ---- Chat commands (replies self-destruct like the rest of the chat) ------
  async function command(chatId, text, msg) {
    const m = /^\/(mybots|alerts)(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);
    if (!m) return false;
    deps.expireAt(chatId, msg.message_id, msgTtlMs);
    const say = t => reply(chatId, t, { ttl: msgTtlMs });
    try {
      if (!(await whenReady())) { await say("Health alerts aren't available right now."); return true; }
      if (await isAdmin(chatId)) { await say("Admin accounts don't get maker health data."); return true; }
      const mk = (await q("SELECT * FROM mh_makers WHERE chat_id=$1", [chatId])).rows[0];
      if (!mk) { await say("You haven't listed a bot from this chat yet. Send a Telegram bot link to list one."); return true; }
      if (m[1].toLowerCase() === "alerts") {
        const a = (m[2] || "").toLowerCase();
        if (a === "on" || a === "off") { await q("UPDATE mh_makers SET alerts_on=$2 WHERE chat_id=$1", [chatId, a === "on"]); await say("Health alerts and the weekly report are now " + a + "."); }
        else await say("Health alerts are " + (mk.alerts_on ? "on" : "off") + ".\n\nSend /alerts on or /alerts off to change it.");
        return true;
      }
      const { rows } = await q("SELECT * FROM mh_bots WHERE owner_chat_id=$1 ORDER BY created_at ASC LIMIT 12", [chatId]);
      const parts = [];
      for (const b of rows) { const up = await upvotes(b); parts.push((b.status === "down" ? "⚠️ " : "✅ ") + b.name + " (@" + b.username + ")\n   Upvotes: " + num(up) + " · Monthly users: " + num(b.monthly_users)); }
      await say("Your bots on Kiver\n\n" + parts.join("\n\n") + "\n\nAlerts are " + (mk.alerts_on ? "on" : "off") + ". Send /alerts off to change it.");
    } catch (e) { log("command:", e.message); try { await say("Something went wrong. Please try again."); } catch (_) {} }
    return true;
  }

  async function start() {
    initP = init();
    if (!(await initP)) return;
    console.log("Maker health is on.");
    setTimeout(() => checkAll(), 90000);
    setInterval(() => checkAll(), CHECK_EVERY_MS);
    setInterval(() => sendDigests(), 30 * 60000);
  }

  // Shared with the other features so everything uses one database connection.
  const query = async (sql, params) => { if (!(await whenReady())) throw new Error("Database unavailable"); return q(sql, params); };
  return { start, enroll, markAdmin, command, query, isReady: whenReady, _t: { init, probe, checkOne, digestFor, sendDigests, checkAll, q: (...a) => q(...a), isAdmin } };
};
