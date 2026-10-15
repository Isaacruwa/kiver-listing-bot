// Public lists shown from the main menu: "Featured Mini apps" and "Top Bots/Apps".
// Data comes from the Kiver directory (upvotes on the listing, review counts from the reviews action).
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const brief = s => String(s).split(/\s+[|–—]\s+|\s+-\s+/)[0].trim() || String(s); // "PipMentor | Forex Trading Coach" -> "PipMentor"
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const short = (s, n = 28) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const MEDALS = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const LIST_TTL = 5 * 60000, CACHE_MS = 5 * 60000;

module.exports = function createLists({ kiver, reply, expireAt, msgTtlMs }) {
  let cache = { at: 0, rows: null };
  const log = (...a) => console.error("[lists]", ...a);

  async function reviewCount(slug) {
    try { const r = await kiver("reviews", { slug }); return r && Array.isArray(r.reviews) ? r.reviews.length : 0; } catch (_) { return 0; }
  }
  // Candidates: the most upvoted listings plus every featured one, each with its review count (cached for 5 minutes).
  async function load() {
    if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const all = (await kiver("list", { sort: "top", limit: 100, offset: 0 })) || [];
    const pick = new Map();
    all.slice(0, 20).forEach(r => pick.set(r.slug, r));
    all.filter(r => r.featured).forEach(r => pick.set(r.slug, r));
    const rows = [...pick.values()];
    const counts = await Promise.all(rows.map(r => reviewCount(r.slug)));
    rows.forEach((r, i) => { r.upvotes = Number(r.upvotes) || 0; r.reviews = counts[i]; });
    cache = { at: Date.now(), rows };
    return rows;
  }

  const line = (r, i) => `${MEDALS[i] || i + 1 + "."} <b>${esc(brief(r.name))}</b>\n      @${esc(r.telegram_username)}  ·  ▲ ${plural(r.upvotes, "upvote")}  ·  💬 ${plural(r.reviews, "review")}`;
  const SEE_ALL = [{ text: "🌐 See all on Kiver", url: "https://getkiver.com/directory" }];
  const buttons = (extra) => ({ inline_keyboard: [...extra, SEE_ALL] }); // no per-bot "Open" buttons; only the actions below the list

  function screen(kind, rows) {
    if (kind === "featured") {
      const f = rows.filter(r => r.featured).sort((a, b) => b.upvotes - a.upvotes || b.reviews - a.reviews).slice(0, 10);
      if (!f.length) return { text: "<b>Featured Mini apps</b>\n\nNothing is featured right now.\nWant your bot here?", markup: buttons([[{ text: "⭐ Feature a bot", callback_data: "fp" }]]) };
      return { text: `<b>Featured Mini apps</b>\nFeatured on Kiver right now.\n\n${f.map(line).join("\n\n")}`, markup: buttons([[{ text: "⭐ Feature a bot", callback_data: "fp" }]]) };
    }
    const t = [...rows].sort((a, b) => (b.upvotes + b.reviews) - (a.upvotes + a.reviews) || b.upvotes - a.upvotes).slice(0, 5);
    if (!t.length) return { text: "<b>Top Bots/Apps</b>\n\nNothing is ranked yet.", markup: buttons([]) };
    return { text: `<b>Top Bots/Apps</b>\nThe 5 most upvoted and reviewed on Kiver.\n\n${t.map(line).join("\n\n")}`, markup: buttons([]) };
  }

  // Reply-keyboard buttons (and typed equivalents).
  async function command(chatId, text, msg) {
    const t = String(text).trim();
    // The current labels, plus the earlier ones still showing on keyboards people already have.
    const kind = /^((⭐ )?Featured (Mini )?Apps)$/i.test(t) || /^\/featured(?:@\w+)?\s*$/i.test(t) ? "featured" : /^((🔥 )?Top (Bots\/)?Apps)$/i.test(t) || /^\/top(?:@\w+)?\s*$/i.test(t) ? "top" : null;
    if (!kind) return false;
    expireAt(chatId, msg.message_id, msgTtlMs);
    try {
      const s = screen(kind, await load());
      await reply(chatId, s.text, { ttl: LIST_TTL, extra: { parse_mode: "HTML", disable_web_page_preview: true, ...(s.markup ? { reply_markup: s.markup } : {}) } });
    } catch (e) {
      log("command:", e.message);
      try { await reply(chatId, "I couldn't load that list right now. Please try again in a moment.", { ttl: msgTtlMs }); } catch (_) {}
    }
    return true;
  }

  // Keep the lists warm so the first tap is instant.
  setTimeout(() => load().catch(() => {}), 20000);
  setInterval(() => { cache.at = 0; load().catch(() => {}); }, 4 * 60000);

  return { command, _t: { load, screen } };
};
