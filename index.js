const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 10000);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const KIVER_CHANNEL_ID = process.env.KIVER_CHANNEL_ID || "";
const KIVER_DB_URL = "https://ovxytcfhyzqtxzhsmmhn.supabase.co/functions/v1/kiver-db";
const KIVER_API_KEY = Buffer.from("c2JfcHVibGlzaGFibGVfTTd3TlNaUzlVd3lQcHRJZEVwaEwyZ19JTG1aT3JYaQ==","base64").toString();

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const BOT_EMAIL = process.env.KIVER_AUTOMATION_EMAIL || "listing-bot@kiver.internal";
const BOT_PASSWORD = process.env.KIVER_AUTOMATION_PASSWORD || crypto.createHash("sha256").update(TELEGRAM_TOKEN).digest("hex");

async function tg(method, body={}) {
  const r = await fetch("https://api.telegram.org/bot"+TELEGRAM_TOKEN+"/"+method, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || "Telegram API error");
  return d.result;
}

async function kiver(action, params={}, token=null) {
  const r = await fetch(KIVER_DB_URL, {
    method:"POST",
    headers:{"content-type":"application/json","apikey":KIVER_API_KEY,"Authorization":"Bearer "+(token || KIVER_API_KEY)},
    body:JSON.stringify({action,params})
  });
  const d = await r.json();
  if (!r.ok || !d.ok) throw new Error(d.error || "Kiver database request failed");
  return d.result;
}

async function kiverSession() {
  try {
    const x = await kiver("signup",{email:BOT_EMAIL,password:BOT_PASSWORD});
    if (x?.token) return x.token;
  } catch (_) {}
  const x = await kiver("login",{email:BOT_EMAIL,password:BOT_PASSWORD});
  if (!x?.token) throw new Error("Kiver automation account could not authenticate");
  return x.token;
}

function parseLink(text) {
  const m = String(text||"").trim().match(/https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([^\s/?#]+)/i);
  if (!m) return null;
  const username = m[1].replace(/^@/,"");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;
  return {username, url:"https://t.me/"+username};
}

function decode(s) {
  return String(s||"")
    .replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCharCode(parseInt(x,16)))
    .replace(/&#(\d+);/g,(_,x)=>String.fromCharCode(Number(x)));
}

function meta(html) {
  const out={};
  for (const tag of html.match(/<meta\b[^>]*>/gi)||[]) {
    const a={}; let m;
    const re=/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi;
    while((m=re.exec(tag))) a[m[1].toLowerCase()]=decode(m[3]);
    const key=(a.property||a.name||a.itemprop||"").toLowerCase();
    if(key && !out[key] && a.content) out[key]=a.content;
  }
  return out;
}

function pageDescription(html) {
  const m=html.match(/<div[^>]+class=["'][^"']*tgme_page_description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if(!m) return "";
  return decode(m[1].replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
}

async function inspectTelegramBot(link) {
  const p=parseLink(link);
  if(!p) throw new Error("Send a direct Telegram bot link such as https://t.me/examplebot");

  const r=await fetch(p.url,{headers:{"user-agent":"Mozilla/5.0 KiverListingBot/1.0","accept":"text/html,application/xhtml+xml"}});
  if(!r.ok) throw new Error("Telegram link could not be reached");

  const html=await r.text(), m=meta(html);
  const title=(m["og:title"]||m["twitter:title"]||"").replace(/\s*\|\s*Telegram.*$/i,"").replace(/^Telegram:\s*/i,"").trim();
  const about=(m["og:description"]||m["twitter:description"]||m.description||"").replace(/^Telegram:\s*/i,"").trim();
  const description=pageDescription(html);
  const imageUrl=m["og:image"]||m["twitter:image"]||m["twitter:image:src"]||"";

  return {
    telegramUsername:p.username,
    telegramUrl:p.url,
    name:title||p.username,
    about,
    description:description||about,
    imageUrl,
    kind:"Bot"
  };
}

const BLOCKED = [
  /\bsexbots?\b/i,/\bporn(?:ography)?\b/i,/\bnudes?\b/i,/\bxxx\b/i,/\berotic\b/i,
  /\badult\s*(chat|content|video|bot)/i,/\bescort/i,/\bprostitut/i,/\bsex\s*(chat|dating|service)/i,
  /\bcocaine\b/i,/\bheroin\b/i,/\bmeth\b/i,/\bfentanyl\b/i,/\bweed\s*delivery\b/i,
  /\bdrug\s*(dealer|deals|sales|selling)\b/i,/\bbuy\s*(drugs|cocaine|heroin|meth)\b/i,
  /\bmalware\b/i,/\bransomware\b/i,/\bphishing\s*kit/i,/\bstolen\s*(cards?|accounts?)/i,
  /\bcarding\b/i,/\bcredential\s*stuffing\b/i,/\bbotnet\b/i
];

function passesFilters(b) {
  const about=String(b.about||"").trim();
  const name=String(b.name||"").trim();
  const username=String(b.telegramUsername||"").trim();
  if(!name) return "Bot name is missing.";
  if(!b.imageUrl) return "A profile photo is required.";
  if(about.length < 50) return "The Telegram About section is too short.";
  if(about.length > 255) return "The Telegram About section is too long.";
  const hay=[name,username,about].join("\n");
  if(BLOCKED.some(re=>re.test(hay))) return "This bot does not meet Kiver listing requirements.";
  return null;
}

async function processSubmission(chatId, link) {
  const b=await inspectTelegramBot(link);
  const rejection=passesFilters(b);
  if(rejection) {
    await tg("sendMessage",{chat_id:chatId,text:"Not eligible for Kiver.\n\n"+rejection});
    return;
  }

  const session=await kiverSession();
  const existing=await kiver("byUser",{username:b.telegramUsername},session);
  if(existing) {
    await tg("sendMessage",{chat_id:chatId,text:"This Telegram bot is already listed on Kiver:\nhttps://getkiver.com/bot/"+existing.slug});
    return;
  }

  const listing=await kiver("addBot",{
    telegramUsername:b.telegramUsername,
    telegramUrl:b.telegramUrl,
    name:b.name,
    about:b.about,
    description:b.description || b.about,
    imageUrl:b.imageUrl,
    kind:"Bot",
    websiteUrl:"",
    category:"other"
  },session);

  const slug=listing?.slug;
  const publicUrl="https://getkiver.com/bot/"+slug;
  await tg("sendMessage",{chat_id:chatId,text:"Listed on Kiver.\n\n"+b.name+"\n"+publicUrl});

  if(KIVER_CHANNEL_ID) {
    const caption=b.name+"\n\n"+b.about+"\n\nView on Kiver: "+publicUrl+"\nOpen bot: "+b.telegramUrl;
    if(b.imageUrl) {
      try { await tg("sendPhoto",{chat_id:KIVER_CHANNEL_ID,photo:b.imageUrl,caption:caption.slice(0,1024)}); }
      catch { await tg("sendMessage",{chat_id:KIVER_CHANNEL_ID,text:caption.slice(0,4096)}); }
    } else {
      await tg("sendMessage",{chat_id:KIVER_CHANNEL_ID,text:caption.slice(0,4096)});
    }
  }
}

let running=false;
async function poll() {
  if(running) return;
  running=true;
  let offset=0;
  try {
    while(true) {
      const updates=await tg("getUpdates",{offset,timeout:30,limit:50,allowed_updates:["message"]});
      for(const u of updates) {
        offset=Math.max(offset,u.update_id+1);
        const msg=u.message;
        if(!msg || !msg.text || msg.chat?.type!=="private") continue;
        const text=msg.text.trim();
        if(/^\/start(?:\s|$)/i.test(text)) {
          await tg("sendMessage",{chat_id:msg.chat.id,text:"Send only the Telegram bot link.\n\nExample:\nhttps://t.me/examplebot"});
          continue;
        }
        try {
          await tg("sendMessage",{chat_id:msg.chat.id,text:"Checking the Telegram bot and preparing its Kiver listing..."});
          await processSubmission(msg.chat.id,text);
        } catch(e) {
          console.error(e);
          await tg("sendMessage",{chat_id:msg.chat.id,text:"I couldn't create that listing.\n\n"+(e.message||"Please try another bot link.")});
        }
      }
    }
  } finally { running=false; }
}

http.createServer((req,res)=>{
  if(req.url==="/health"){res.writeHead(200,{"content-type":"text/plain"});return res.end("ok");}
  res.writeHead(200,{"content-type":"text/plain"});res.end("Kiver Listing Bot");
}).listen(PORT,()=>{console.log("Kiver Listing Bot listening on "+PORT);poll().catch(e=>console.error(e));});
