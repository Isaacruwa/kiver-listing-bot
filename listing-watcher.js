const KIVER_DB_URL = process.env.KIVER_DB_URL || "https://ovxytcfhyzqtxzhsmmhn.supabase.co/functions/v1/kiver-db";
const KIVER_API_KEY = process.env.KIVER_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const KIVER_CHANNEL_ID = process.env.KIVER_CHANNEL_ID;

if (!KIVER_API_KEY) throw new Error("KIVER_API_KEY is required");
if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!KIVER_CHANNEL_ID) throw new Error("KIVER_CHANNEL_ID is required");

async function kiver(action, params = {}) {
  const r = await fetch(KIVER_DB_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": KIVER_API_KEY,
      "Authorization": "Bearer " + KIVER_API_KEY
    },
    body: JSON.stringify({ action, params })
  });
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.error || "Kiver database request failed");
  return d.result;
}

async function tg(method, body = {}) {
  const r = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || "Telegram API error");
  return d.result;
}

function parseTelegramImage(html) {
  const m = html.match(/<meta\b[^>]*(?:property|name)=[\"'](?:og:image|twitter:image|twitter:image:src)[\"'][^>]*content=[\"']([^\"']+)[\"'][^>]*>/i);
  return m ? m[1].replace(/&amp;/gi, "&") : "";
}

async function getImage(listing) {
  if (listing.image_url) return listing.image_url;
  if (!listing.telegram_url) return "";
  try {
    const r = await fetch(listing.telegram_url, { headers: { "user-agent": "Mozilla/5.0 KiverListingWatcher/1.0" } });
    if (!r.ok) return "";
    return parseTelegramImage(await r.text());
  } catch (_) {
    return "";
  }
}

async function announce(listing) {
  const kiverUrl = "https://getkiver.com/bot/" + listing.slug;
  const telegramUrl = listing.telegram_url || (listing.telegram_username ? "https://t.me/" + listing.telegram_username : "");
  const username = listing.telegram_username ? "@" + listing.telegram_username : "";
  const about = String(listing.about || listing.description || "").trim();
  const caption = [
    "🤖 " + String(listing.name || username || "Telegram Bot"),
    username,
    "",
    about,
    "",
    "Discover on Kiver: " + kiverUrl,
    telegramUrl ? "Open Bot: " + telegramUrl : ""
  ].filter(Boolean).join("\n");

  const image = await getImage(listing);
  if (image) {
    try {
      await tg("sendPhoto", {
        chat_id: KIVER_CHANNEL_ID,
        photo: image,
        caption: caption.slice(0, 1024)
      });
      return;
    } catch (e) {
      console.error("Photo announcement failed; sending text:", e.message);
    }
  }

  await tg("sendMessage", {
    chat_id: KIVER_CHANNEL_ID,
    text: caption.slice(0, 4096)
  });
}

async function main() {
  const rows = await kiver("list", { sort: "new", limit: 60, offset: 0 });
  const now = Date.now();
  const lookbackMs = Number(process.env.LISTING_LOOKBACK_MINUTES || 4) * 60 * 1000;

  const candidates = (rows || [])
    .filter(x => x.created_at && now - new Date(x.created_at).getTime() <= lookbackMs)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!candidates.length) {
    console.log("No newly created approved listings in the current polling window.");
    return;
  }

  for (const listing of candidates) {
    await announce(listing);
    console.log("Announced listing:", listing.id, listing.slug);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
