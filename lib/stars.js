// Button-driven maker tools: "My bots" and paid "Featured" placement, sold with Telegram Stars (currency XTR).
// Safety rules so the website is never harmed:
//  - only the person who listed a bot can buy for it
//  - a listing that is already featured by something else (e.g. a website plan) can never be bought
//  - when a Stars purchase ends, only a feature that THIS module switched on is switched off, and only if nobody changed it since
//  - every payment is stored; a failed fulfilment is retried, then refunded automatically
const crypto = require("crypto");
const DAY = 86400000;
const PRICES = { 7: Number(process.env.KIVER_STARS_7D) || 300, 30: Number(process.env.KIVER_STARS_30D) || 1000 };
const MENU_TTL = 5 * 60000, INVOICE_TTL = 10 * 60000, MAX_ATTEMPTS = 6;
const hsh = slug => crypto.createHash("sha1").update(String(slug)).digest("hex").slice(0, 10);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = n => (n == null ? "–" : Number(n).toLocaleString("en-US"));
const day = d => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const short = (s, n = 26) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const saving = () => Math.max(0, Math.round((1 - PRICES[30] / (PRICES[7] * 30 / 7)) * 100));

module.exports = function createStars(deps) {
  const { tg, kiver, reply, expireAt, secret, makers, msgTtlMs } = deps;
  const log = (...a) => console.error("[stars]", ...a);
  const q = (s, p) => makers.query(s, p);
  let ready = false, initP = null;
  const inflight = new Set();
  const invoiceMsgs = new Map(); // chat:payload -> invoice message id (a paid invoice stays in the chat as a record)

  async function init() {
    try {
      if (!(await makers.isReady())) return false;
      await q(`CREATE TABLE IF NOT EXISTS mh_star_orders (id BIGSERIAL PRIMARY KEY, charge_id TEXT UNIQUE NOT NULL, chat_id BIGINT NOT NULL, slug TEXT NOT NULL, days INT NOT NULL, stars INT NOT NULL, status TEXT NOT NULL DEFAULT 'paid', attempts INT NOT NULL DEFAULT 0, last_error TEXT, ends_at TIMESTAMPTZ, created_row BOOLEAN, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS mh_featured (slug TEXT PRIMARY KEY, owner_chat_id BIGINT NOT NULL, ends_at TIMESTAMPTZ NOT NULL, featured_at_seen TEXT, verified_seen BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      ready = true; return true;
    } catch (e) { log("init failed:", e.message); return false; }
  }
  const whenReady = async () => { if (initP) await initP; return ready; }; // updates queued during a restart can arrive early

  // ---------- helpers ----------
  const myBots = async chatId => (await q("SELECT slug,name,username,monthly_users,status FROM mh_bots WHERE owner_chat_id=$1 ORDER BY created_at ASC LIMIT 12", [chatId])).rows;
  const listing = async b => { try { const rows = await kiver("list", { q: b.username, sort: "top", limit: 12, offset: 0 }); return (rows || []).find(r => r.slug === b.slug) || null; } catch (_) { return null; } };
  const featuredRow = async slug => (await q("SELECT * FROM mh_featured WHERE slug=$1", [slug])).rows[0];
  async function status(b) {
    const l = await listing(b);
    if (!l) return { ok: false, why: "That listing isn't live on Kiver yet." };
    const row = await featuredRow(b.slug);
    if (l.featured && !row) return { ok: false, why: "This bot is already featured on Kiver." };
    return { ok: true, l, row };
  }
  async function admins() { try { return (await q("SELECT chat_id FROM mh_admins")).rows.map(r => r.chat_id); } catch (_) { return []; } }
  async function tellAdmins(text) { for (const id of await admins()) { try { await tg("sendMessage", { chat_id: Number(id), text, parse_mode: "HTML", disable_web_page_preview: true }); } catch (_) {} } }
  const dm = (chatId, text, markup) => tg("sendMessage", { chat_id: Number(chatId), text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
  const send = (chatId, text, markup) => reply(chatId, text, { ttl: MENU_TTL, extra: { parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) } });
  const edit = async (cq, text, markup) => {
    try { await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) }); }
    catch (e) { if (!/not modified/i.test(e.message)) await send(cq.message.chat.id, text, markup); }
  };
  const ack = (cq, text, alert) => tg("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: !!alert } : {}) }).catch(() => {});

  // ---------- screens ----------
  async function botsCard(chatId) {
    const bots = await myBots(chatId);
    const mk = (await q("SELECT alerts_on FROM mh_makers WHERE chat_id=$1", [chatId])).rows[0];
    if (!bots.length) return { text: "<b>📋 Your bots</b>\n\nYou haven't listed a bot from this chat yet.\nSend me a Telegram bot link and I'll list it for you.", markup: { inline_keyboard: [[{ text: "🌐 Browse Kiver", url: "https://getkiver.com" }]] } };
    const info = await Promise.all(bots.map(async b => ({ b, l: await listing(b), row: await featuredRow(b.slug) })));
    const lines = info.map(({ b, l, row }) => {
      const feat = row && new Date(row.ends_at) > new Date() ? `\n      ⭐ Featured until ${day(row.ends_at)}` : (l && l.featured ? "\n      ⭐ Featured" : "");
      return `${b.status === "down" ? "⚠️" : "✅"} <b>${esc(b.name)}</b>  <i>@${esc(b.username)}</i>\n      ▲ ${num(l ? l.upvotes : null)} upvotes  ·  👥 ${num(b.monthly_users)} monthly${feat}`;
    });
    const rows = info.map(({ b, l, row }) => {
      const mine = row && new Date(row.ends_at) > new Date();
      if (l && l.featured && !mine) return [{ text: `⭐ ${short(b.name)} is featured`, callback_data: "fx" }];
      return [{ text: `${mine ? "⭐ Extend" : "⭐ Feature"} · ${short(b.name)}`, callback_data: "fs:" + hsh(b.slug) }];
    });
    rows.push([{ text: mk && mk.alerts_on ? "🔔 Alerts on · tap to turn off" : "🔕 Alerts off · tap to turn on", callback_data: "fa" }]);
    return { text: `<b>📋 Your bots</b>\n\n${lines.join("\n\n")}`, markup: { inline_keyboard: rows } };
  }
  async function planCard(b) {
    const st = await status(b);
    if (!st.ok) return { text: `<b>⭐ Feature ${esc(b.name)}</b>\n\n${esc(st.why)}`, markup: { inline_keyboard: [[{ text: "‹ Back", callback_data: "fb" }]] } };
    const mine = st.row && new Date(st.row.ends_at) > new Date();
    const intro = mine ? `Featured until <b>${day(st.row.ends_at)}</b>. A new plan adds time on top.` : `Put <b>${esc(b.name)}</b> in front of more people on Kiver.`;
    const h = hsh(b.slug);
    return { text: `<b>⭐ Feature ${esc(b.name)}</b>\n\n${intro}\n\nPick a plan and pay in Telegram Stars. It goes live right after payment.`, markup: { inline_keyboard: [[{ text: `7 days  ·  ${num(PRICES[7])} ⭐`, callback_data: `fd:${h}:7` }], [{ text: `30 days  ·  ${num(PRICES[30])} ⭐${saving() ? `  ·  save ${saving()}%` : ""}`, callback_data: `fd:${h}:30` }], [{ text: "‹ Back", callback_data: "fb" }]] } };
  }
  const pickerCard = bots => ({ text: "<b>⭐ Feature a bot</b>\n\nWhich bot do you want to promote?", markup: { inline_keyboard: bots.map(b => [{ text: short(b.name, 40), callback_data: "fs:" + hsh(b.slug) }]) } });

  // Entry point for the reply-keyboard buttons and the /feature, /mybots commands.
  async function command(chatId, text, msg) {
    const t = String(text).trim();
    const isBots = t === "📋 My bots" || /^\/mybots(?:@\w+)?\s*$/i.test(t);
    const isFeat = t === "⭐ Feature a bot" || t === "🚀 Promote a bot" || /^\/feature(?:@\w+)?\s*$/i.test(t);
    if (!isBots && !isFeat) return false;
    expireAt(chatId, msg.message_id, msgTtlMs);
    try {
      if (!(await whenReady())) { await send(chatId, "This isn't available right now. Please try again in a moment."); return true; }
      if (await makers.isAdmin(chatId)) { await send(chatId, "Admin accounts don't use the maker tools. Use the Admin Panel instead."); return true; }
      const bots = await myBots(chatId);
      if (isBots || !bots.length) { const c = await botsCard(chatId); await send(chatId, c.text, c.markup); return true; }
      const c = bots.length === 1 ? await planCard(bots[0]) : pickerCard(bots);
      await send(chatId, c.text, c.markup);
    } catch (e) { log("command:", e.message); try { await send(chatId, "Something went wrong. Please try again."); } catch (_) {} }
    return true;
  }

  async function callback(cq) {
    const d = String(cq.data || "");
    if (!/^(fs:|fd:|fa$|fb$|fx$|fp$)/.test(d)) return false;
    const uid = cq.from.id;
    try {
      if (!(await whenReady())) { await ack(cq, "Not available right now.", true); return true; }
      if (d === "fp") { // "Get featured" button on the Featured Apps list
        await ack(cq);
        const bots = await myBots(uid);
        if (!bots.length) { await send(uid, "<b>🚀 Promote a bot</b>\n\nSend me a Telegram bot link and I'll list it first. Then you can feature it here.", { inline_keyboard: [[{ text: "🌐 Browse Kiver", url: "https://getkiver.com" }]] }); return true; }
        const c = bots.length === 1 ? await planCard(bots[0]) : pickerCard(bots);
        await send(uid, c.text, c.markup); return true;
      }
      if (d === "fx") { await ack(cq, "This bot is already featured on Kiver.", true); return true; }
      if (d === "fb") { await ack(cq); const c = await botsCard(uid); await edit(cq, c.text, c.markup); return true; }
      if (d === "fa") { await q("UPDATE mh_makers SET alerts_on = NOT alerts_on WHERE chat_id=$1", [uid]); await ack(cq, "Updated"); const c = await botsCard(uid); await edit(cq, c.text, c.markup); return true; }
      const [kind, hh, days] = d.split(":");
      const b = (await myBots(uid)).find(x => hsh(x.slug) === hh);
      if (!b) { await ack(cq, "I couldn't find that bot in your list.", true); return true; }
      if (kind === "fs") { await ack(cq); const c = await planCard(b); await edit(cq, c.text, c.markup); return true; }
      if (!PRICES[days]) { await ack(cq); return true; }
      const st = await status(b);
      if (!st.ok) { await ack(cq, st.why, true); return true; }
      await ack(cq, "Opening checkout…");
      const inv = await tg("sendInvoice", { chat_id: uid, title: ("Feature " + b.name).slice(0, 32), description: `Featured placement for ${b.name} on Kiver for ${days} days. It goes live as soon as your payment is confirmed.`.slice(0, 255), payload: `feat:${hsh(b.slug)}:${days}`, currency: "XTR", prices: [{ label: `${days} days featured`, amount: PRICES[days] }] });
      expireAt(uid, inv.message_id, INVOICE_TTL); // an unpaid invoice clears itself; a paid one is kept
      invoiceMsgs.set(uid + ":" + `feat:${hsh(b.slug)}:${days}`, inv.message_id);
    } catch (e) { log("callback:", e.message); await ack(cq, "Something went wrong. Please try again.", true); }
    return true;
  }

  // Telegram asks us to approve the payment before the user is charged (must answer within 10 seconds).
  async function preCheckout(pq) {
    const answer = (okay, message) => tg("answerPreCheckoutQuery", { pre_checkout_query_id: pq.id, ok: okay, ...(okay ? {} : { error_message: message }) });
    try {
      if (!(await whenReady())) return answer(false, "Payments aren't available right now. You haven't been charged.");
      const [kind, hh, days] = String(pq.invoice_payload || "").split(":");
      if (kind !== "feat" || pq.currency !== "XTR" || !PRICES[days] || pq.total_amount !== PRICES[days]) return answer(false, "This offer is no longer valid. Please start again from Feature a bot.");
      const b = (await myBots(pq.from.id)).find(x => hsh(x.slug) === hh);
      if (!b) return answer(false, "We couldn't find that bot in your list.");
      const st = await status(b);
      return st.ok ? answer(true) : answer(false, st.why);
    } catch (e) { log("pre-checkout:", e.message); return answer(false, "Something went wrong. You haven't been charged. Please try again.").catch(() => {}); }
  }

  // Money has been taken: record it first (idempotent), then fulfil.
  async function paid(msg) {
    const sp = msg.successful_payment, uid = msg.from.id;
    const invId = (msg.reply_to_message && msg.reply_to_message.message_id) || invoiceMsgs.get(uid + ":" + sp.invoice_payload);
    if (invId && deps.cancelExpire) deps.cancelExpire(uid, invId); // payment records are never auto-deleted
    if (!(await whenReady())) { log("PAYMENT RECEIVED BUT STORAGE DOWN", sp.telegram_payment_charge_id, uid); await tellAdmins(`🚨 <b>Payment received but storage is down</b>\nCharge: <code>${esc(sp.telegram_payment_charge_id)}</code>\nUser: ${uid}\nPayload: ${esc(sp.invoice_payload)}`); return; }
    const [, hh, days] = String(sp.invoice_payload || "").split(":");
    const b = (await myBots(uid)).find(x => hsh(x.slug) === hh);
    const ins = await q("INSERT INTO mh_star_orders(charge_id,chat_id,slug,days,stars) VALUES($1,$2,$3,$4,$5) ON CONFLICT (charge_id) DO NOTHING RETURNING id", [sp.telegram_payment_charge_id, uid, b ? b.slug : "unknown", Number(days) || 0, sp.total_amount]);
    if (!ins.rowCount) return; // already handled
    if (!b || !PRICES[days]) { const o = (await q("SELECT * FROM mh_star_orders WHERE id=$1", [ins.rows[0].id])).rows[0]; return failAndRefund(o, "Order could not be matched to a bot"); }
    await fulfill(ins.rows[0].id);
  }

  async function failAndRefund(o, reason) {
    let refunded = false;
    try { await tg("refundStarPayment", { user_id: Number(o.chat_id), telegram_payment_charge_id: o.charge_id }); refunded = true; } catch (e) { log("REFUND FAILED", o.charge_id, e.message); }
    try {
      if (o.ends_at) { // undo what we applied for this order
        if (o.created_row) {
          const row = await featuredRow(o.slug);
          if (row && row.featured_at_seen) await kiver("automationAdminFeature", { automationSecret: secret, slug: o.slug, featured: false });
          await q("DELETE FROM mh_featured WHERE slug=$1", [o.slug]);
        } else await q("UPDATE mh_featured SET ends_at = ends_at - $2::int * interval '1 day' WHERE slug=$1", [o.slug, o.days]);
      }
    } catch (e) { log("undo failed:", e.message); }
    await q("UPDATE mh_star_orders SET status=$2, last_error=$3, updated_at=now() WHERE id=$1", [o.id, refunded ? "refunded" : "refund_failed", String(reason).slice(0, 300)]).catch(() => {});
    try { await dm(o.chat_id, refunded ? `↩️ <b>We couldn't feature your bot, so your ${num(o.stars)} ⭐ were refunded.</b>\n\n${esc(reason)}.` : `⚠️ <b>We couldn't feature your bot.</b>\nYour payment is being refunded by our team.`); } catch (_) {}
    await tellAdmins(`${refunded ? "↩️ Refunded" : "🚨 REFUND FAILED"} ${num(o.stars)} ⭐ · slug <code>${esc(o.slug)}</code>\nReason: ${esc(reason)}\nCharge: <code>${esc(o.charge_id)}</code>`);
  }

  async function fulfill(id) {
    if (inflight.has(id)) return; inflight.add(id);
    let o = null;
    try {
      o = (await q("UPDATE mh_star_orders SET status='applying', attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='paid' RETURNING *", [id])).rows[0]
        || (await q("UPDATE mh_star_orders SET attempts=attempts+1, updated_at=now() WHERE id=$1 AND status='applying' RETURNING *", [id])).rows[0];
      if (!o) return;
      const bot = (await q("SELECT slug,name,username FROM mh_bots WHERE slug=$1", [o.slug])).rows[0];
      if (!bot) return failAndRefund(o, "The listing could not be found");
      const l = await listing(bot);
      if (o.ends_at == null) { // nothing applied yet: last chance to refuse safely
        const row = await featuredRow(o.slug);
        if (!l) return failAndRefund(o, "The listing isn't live on Kiver");
        if (l.featured && !row) return failAndRefund(o, "This bot is already featured on Kiver");
        const r = await q(`WITH t AS (SELECT id FROM mh_star_orders WHERE id=$4 AND status='applying' AND ends_at IS NULL FOR UPDATE),
          f AS (INSERT INTO mh_featured(slug,owner_chat_id,ends_at) SELECT $1,$2,now() + $3::int * interval '1 day' FROM t
                ON CONFLICT (slug) DO UPDATE SET ends_at = GREATEST(mh_featured.ends_at, now()) + $3::int * interval '1 day'
                RETURNING ends_at, (xmax = 0) AS inserted)
          UPDATE mh_star_orders o SET ends_at=f.ends_at, created_row=f.inserted FROM f WHERE o.id=$4 RETURNING o.ends_at, o.created_row`, [o.slug, o.chat_id, o.days, o.id]);
        if (r.rowCount) { o.ends_at = r.rows[0].ends_at; o.created_row = r.rows[0].created_row; }
        else o = (await q("SELECT * FROM mh_star_orders WHERE id=$1", [id])).rows[0];
      }
      const turnedOn = !(l && l.featured);
      if (turnedOn) await kiver("automationAdminFeature", { automationSecret: secret, slug: o.slug, featured: true });
      const after = await listing(bot);
      if (!after || !after.featured) throw new Error("Feature flag did not stick");
      if (turnedOn) await q("UPDATE mh_featured SET featured_at_seen=$2, verified_seen=$3 WHERE slug=$1", [o.slug, String(after.featured_at || ""), !!after.verified]);
      await q("UPDATE mh_star_orders SET status='active', last_error=NULL, updated_at=now() WHERE id=$1", [id]);
      const until = (await featuredRow(o.slug)).ends_at;
      try { await dm(o.chat_id, `✅ <b>Payment received. Thank you!</b>\n\n<b>${esc(bot.name)}</b> is now featured on Kiver until <b>${day(until)}</b>.`, { inline_keyboard: [[{ text: "🌐 View on Kiver", url: "https://getkiver.com/bot/" + o.slug }], [{ text: "📣 Share it", switch_inline_query: bot.username }]] }); } catch (e) { log("receipt:", e.message); }
      await tellAdmins(`💫 <b>New sale</b> · ${num(o.stars)} ⭐\n${esc(bot.name)} · ${o.days} days`);
    } catch (e) {
      log("fulfil", id, e.message);
      try {
        await q("UPDATE mh_star_orders SET last_error=$2 WHERE id=$1", [id, String(e.message).slice(0, 300)]);
        const cur = o || (await q("SELECT * FROM mh_star_orders WHERE id=$1", [id])).rows[0];
        if (cur && cur.attempts >= MAX_ATTEMPTS) await failAndRefund(cur, "We couldn't switch it on after several tries");
      } catch (_) {}
    } finally { inflight.delete(id); }
  }

  async function retryStuck() {
    if (!ready) return;
    try { const { rows } = await q("SELECT id FROM mh_star_orders WHERE status IN ('paid','applying') AND updated_at < now() - interval '1 minute' ORDER BY id LIMIT 5"); for (const r of rows) await fulfill(r.id); }
    catch (e) { log("retryStuck:", e.message); }
  }

  // Ends Stars features that have run out. Never switches off something this module did not switch on, or that changed since.
  async function expireDue() {
    if (!ready) return;
    try {
      const { rows } = await q("SELECT * FROM mh_featured WHERE ends_at < now() ORDER BY ends_at LIMIT 10");
      for (const f of rows) {
        try {
          const bot = (await q("SELECT slug,name,username FROM mh_bots WHERE slug=$1", [f.slug])).rows[0];
          const l = bot ? await listing(bot) : null;
          let ended = false;
          if (l && l.featured) {
            const untouched = f.featured_at_seen && String(l.featured_at || "") === f.featured_at_seen && !(l.verified && !f.verified_seen);
            if (untouched) { await kiver("automationAdminFeature", { automationSecret: secret, slug: f.slug, featured: false }); const chk = await listing(bot); if (chk && chk.featured) throw new Error("Could not switch the feature off"); ended = true; }
            else log("leaving", f.slug, "featured: it changed since the Stars purchase");
          }
          await q("DELETE FROM mh_featured WHERE slug=$1", [f.slug]);
          await q("UPDATE mh_star_orders SET status='expired', updated_at=now() WHERE slug=$1 AND status='active'", [f.slug]);
          if (ended && bot) { try { const sent = await dm(f.owner_chat_id, `⭐ <b>Your featured spot for ${esc(bot.name)} has ended.</b>\n\nWant to keep it going?`, { inline_keyboard: [[{ text: "⭐ Feature again", callback_data: "fs:" + hsh(f.slug) }]] }); if (sent && sent.message_id && deps.noticeTtlMs) expireAt(f.owner_chat_id, sent.message_id, deps.noticeTtlMs); } catch (_) {} }
        } catch (e) { log("expire", f.slug, e.message); }
      }
    } catch (e) { log("expireDue:", e.message); }
  }

  function start() {
    initP = init();
    initP.then(ok => {
      if (!ok) { console.log("Stars payments are off (database not ready)."); return; }
      console.log(`Stars payments are on (7 days = ${PRICES[7]} ⭐, 30 days = ${PRICES[30]} ⭐).`);
      setTimeout(() => { retryStuck(); expireDue(); }, 60000);
      setInterval(retryStuck, 2 * 60000);
      setInterval(expireDue, 10 * 60000);
    });
    return initP;
  }

  return { start, command, callback, preCheckout, paid, hash: hsh, PRICES, _t: { fulfill, expireDue, retryStuck, failAndRefund } };
};
