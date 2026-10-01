const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 10000);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const KIVER_CHANNEL_ID = process.env.KIVER_CHANNEL_ID || "@getkiver";
const KIVER_DB_URL = "https://ovxytcfhyzqtxzhsmmhn.supabase.co/functions/v1/kiver-db";
const KIVER_API_KEY = Buffer.from("c2JfcHVibGlzaGFibGVfTTd3TlNaUzlVd3lQcHRJZEVwaEwyZ19JTG1aT3JYaQ==","base64").toString();

if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

const KIVER_AUTOMATION_SECRET = process.env.KIVER_AUTOMATION_SECRET;
if (!KIVER_AUTOMATION_SECRET) throw new Error("KIVER_AUTOMATION_SECRET is required");
const KIVER_ADMIN_KEY = process.env.KIVER_ADMIN_KEY || "";
const DATA_DIR = process.env.KIVER_DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "channel-state.json");
function loadState(){ try { const x=JSON.parse(fs.readFileSync(STATE_FILE,"utf8")); return {channels:Array.isArray(x.channels)?x.channels:[],announced:Array.isArray(x.announced)?x.announced:[]}; } catch(_) { return {channels:[],announced:[]}; } }
const state=loadState();
const pendingChannelRegistration=new Set();
function saveState(){ fs.mkdirSync(DATA_DIR,{recursive:true}); fs.writeFileSync(STATE_FILE,JSON.stringify(state,null,2)); }
if(KIVER_CHANNEL_ID && !state.channels.includes(KIVER_CHANNEL_ID)){ state.channels.push(KIVER_CHANNEL_ID); saveState(); }


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

function parseLink(text) {
  const m = String(text||"").trim().match(/https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([^\s/?#]+)/i);
  if (!m) return null;
  const username = m[1].replace(/^@/,"");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;
  if (!/bot$/i.test(username)) return null;
  return {username, url:"https://t.me/"+username};
}

function parseChannelLink(text){
  const m=String(text||"").trim().match(/https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([^\s/?#]+)/i);
  if(!m) return null;
  const username=m[1].replace(/^@/,"");
  if(!/^[A-Za-z0-9_]{5,32}$/.test(username)) return null;
  return "@"+username;
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
  if(about.length < 40) return "The Telegram About section is too short.";
  const hay=[name,username,about].join("\n");
  if(BLOCKED.some(re=>re.test(hay))) return "This bot does not meet Kiver listing requirements.";
  return null;
}

async function registerChannel(chatId,link){
  pendingChannelRegistration.delete(String(chatId));
  const ref=parseChannelLink(link);
  if(!ref){ await tg("sendMessage",{chat_id:chatId,text:"Send a public Telegram channel link, for example:\nhttps://t.me/yourchannel"}); return; }
  const chat=await tg("getChat",{chat_id:ref});
  if(chat.type!=="channel"){ await tg("sendMessage",{chat_id:chatId,text:"That link is not a Telegram channel."}); return; }
  const me=await tg("getMe");
  const member=await tg("getChatMember",{chat_id:chat.id,user_id:me.id});
  if(!["administrator","creator"].includes(member.status)){ await tg("sendMessage",{chat_id:chatId,text:"I am not an admin in that channel. Add this bot as an administrator, then run /registerchannel again."}); return; }
  const id=String(chat.id);
  if(!state.channels.includes(id)){ state.channels.push(id); saveState(); }
  await tg("sendMessage",{chat_id:chatId,text:"Channel registered.\n\n"+(chat.title||ref)+"\nNew Kiver listings will be posted there automatically."});
  try {
    const latestRows=await kiver("list",{sort:"new",limit:1,offset:0});
    const latest=latestRows?.[0];
    if(latest?.id) await sendListingAnnouncement(id,latest);
  } catch(e) { console.error("Could not announce latest listing to new channel:",e.message); }
}

function listingMessage(listing){
  const name=String(listing.name||"Telegram Bot").trim();
  const username=listing.telegram_username?"@"+String(listing.telegram_username).trim():"";
  const about=String(listing.about||"").trim();
  const kiverUrl="https://getkiver.com/bot/"+listing.slug;
  const text=[name,username,about?("About:\n"+about):"About:"].filter(Boolean).join("\n\n");
  return {text:text.slice(0,4096),kiverUrl};
}

function listingImageUrl(listing){
  const username=String(listing.telegram_username||"").trim();
  return username
    ? "https://getkiver.com/api/image?u="+encodeURIComponent(username)
    : "";
}

async function sendListingAnnouncement(channelId,listing){
  const {text,kiverUrl}=listingMessage(listing);
  const image=listingImageUrl(listing);
  const replyMarkup={inline_keyboard:[[{text:"View on Kiver",url:kiverUrl}]]};
  if(image){
    try {
      await tg("sendPhoto",{chat_id:channelId,photo:image,caption:text.slice(0,1024),reply_markup:replyMarkup});
      return;
    } catch(e) {
      console.error("Kiver image announcement failed; sending text:",e.message);
    }
  }
  await tg("sendMessage",{chat_id:channelId,text,reply_markup:replyMarkup});
}

async function drainPendingAnnouncements(){
  try {
    const listings=await getPendingListings();
    for(const listing of (listings||[])){
      try { await announceListing(listing); }
      catch(e){ console.error("Pending announcement failed:",e.message); }
    }
  } catch(e){
    console.error("Could not load pending announcements:",e.message);
  }
}

async function announceListing(listing){
  const id=String(listing.id||"");
  if(!id||listing.channel_posted_at) return false;
  const channels=KIVER_CHANNEL_ID?[KIVER_CHANNEL_ID]:state.channels.slice();
  if(!channels.length) return false;
  let posted=false;
  for(const channelId of channels){
    try{ await sendListingAnnouncement(channelId,listing); posted=true; }
    catch(e){ console.error("Channel announcement failed for",channelId,e.message); }
  }
  if(posted){
    try{ await kiver("automationMarkChannelPosted",{automationSecret:KIVER_AUTOMATION_SECRET,id}); }
    catch(e){ console.error("Could not mark listing as channel-posted:",e.message); }
  }
  return posted;
}

async function getPendingListings(){
  return await kiver("automationPendingAnnouncements",{automationSecret:KIVER_AUTOMATION_SECRET});
}

async function postPendingListing(id){
  const listings=await getPendingListings();
  const listing=(listings||[]).find(x=>String(x?.id||"")===String(id));
  if(!listing) throw new Error("That listing is no longer pending.");
  const channel=KIVER_CHANNEL_ID||state.channels[0];
  if(!channel) throw new Error("No announcement channel is registered.");
  await sendListingAnnouncement(channel,listing);
  await kiver("automationMarkChannelPosted",{automationSecret:KIVER_AUTOMATION_SECRET,id:String(listing.id)});
  return listing;
}

async function processSubmission(chatId, link) {
  const b=await inspectTelegramBot(link);
  const rejection=passesFilters(b);
  if(rejection) {
    await tg("sendMessage",{chat_id:chatId,text:"Not eligible for Kiver.\n\n"+rejection});
    return;
  }

  const listing=await kiver("automationAddBot",{
    automationSecret:KIVER_AUTOMATION_SECRET,
    telegramUsername:b.telegramUsername,
    telegramUrl:b.telegramUrl,
    name:b.name,
    about:b.about,
    description:b.description || b.about,
    imageUrl:b.imageUrl,
    kind:"Bot",
    websiteUrl:"",
    category:"other"
  });

  const slug=listing?.slug;
  const publicUrl="https://getkiver.com/bot/"+slug;
  await tg("sendMessage",{chat_id:chatId,text:"Listed on Kiver.\n\n"+b.name+"\n"+publicUrl});

  await announceListing({...listing,...b,slug});

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
        if(/^\/registerchannel(?:\s|$)/i.test(text)){
          const inline=text.replace(/^\/registerchannel\s*/i,"").trim();
          if(inline) await registerChannel(msg.chat.id,inline);
          else {
            pendingChannelRegistration.add(String(msg.chat.id));
            await tg("sendMessage",{chat_id:msg.chat.id,text:"Paste the public Telegram channel link now.\n\nExample:\nhttps://t.me/yourchannel"});
          }
          continue;
        }

        if(/^\/start(?:\s|$)/i.test(text)) {
          pendingChannelRegistration.delete(String(msg.chat.id));
          await tg("sendMessage",{
            chat_id:msg.chat.id,
            text:"Send only the Telegram bot link.\n\nE.x : https://t.me/getkiverbot",
            reply_markup:{keyboard:[[{text:"Admin Panel"}]],resize_keyboard:true}
          });
          continue;
        }

        if(text === "Admin Panel"){
          await tg("sendMessage",{
            chat_id:msg.chat.id,
            text:"Admin Panel\n\nUse the controls below to manage the Kiver listing bot.",
            reply_markup:{inline_keyboard:[
              [{text:"Register Channel",callback_data:"admin_register_channel"}],
              [{text:"Announcement Queue",callback_data:"admin_queue"}]
            ]}
          });
          continue;
        }
        if (pendingChannelRegistration.has(String(msg.chat.id))) {
          try {
            await registerChannel(msg.chat.id,text);
          } catch(e) {
            pendingChannelRegistration.delete(String(msg.chat.id));
            await tg("sendMessage",{chat_id:msg.chat.id,text:"I couldn't register that channel.\n\n"+(e.message||"Please send a public Telegram channel link.")});
          }
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

http.createServer(async (req,res)=>{
  if(req.url==="/health"){res.writeHead(200,{"content-type":"text/plain"});return res.end("ok");}
  if(req.url==="/admin/queue"){
    const cors={"content-type":"application/json","cache-control":"no-store","access-control-allow-origin":"https://getkiver.com","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type,x-kiver-admin-key"};
    if(req.method==="OPTIONS"){res.writeHead(204,cors);return res.end();}
    if(!KIVER_ADMIN_KEY || req.headers["x-kiver-admin-key"]!==KIVER_ADMIN_KEY){res.writeHead(401,cors);return res.end(JSON.stringify({error:"Unauthorized"}));}
    try{
      if(req.method==="GET"){
        const listings=await getPendingListings();
        res.writeHead(200,cors);return res.end(JSON.stringify({listings}));
      }
      if(req.method==="POST"){
        let raw="";for await(const chunk of req)raw+=chunk;
        const body=JSON.parse(raw||"{}");
        const listing=await postPendingListing(String(body.listingId||""));
        res.writeHead(200,cors);return res.end(JSON.stringify({ok:true,listing}));
      }
      res.writeHead(405,cors);return res.end(JSON.stringify({error:"Method not allowed"}));
    }catch(e){res.writeHead(400,cors);return res.end(JSON.stringify({error:e.message||"Queue request failed"}));}
  }
  res.writeHead(200,{"content-type":"text/plain"});res.end("Kiver Listing Bot");
}).listen(PORT,()=>{
  console.log("Kiver Listing Bot listening on "+PORT);
  drainPendingAnnouncements().catch(e=>console.error(e));
  poll().catch(e=>console.error(e));
});
