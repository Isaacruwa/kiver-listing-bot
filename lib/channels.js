// Registry of extra channels that receive every new Kiver listing, stored in Postgres so it survives redeploys.
// The bot registers a channel automatically when it is made an admin there (my_chat_member), or via /registerchannel.
const MAX = Math.max(1, Number(process.env.KIVER_MAX_CHANNELS || 100));

module.exports = function createChannels({ makers, mainChannel }) {
  const cache = new Map(); // chat id (string) -> title
  let ready = false, startP = null;
  const whenReady = async () => { if (startP) await startP; return ready; }; // updates queued during a restart can arrive before the database is connected
  const log = (...a) => console.error("[channels]", ...a);
  const isMain = (id, username) => {
    const m = String(mainChannel || "").toLowerCase();
    return !!m && (String(id).toLowerCase() === m || (username && ("@" + username).toLowerCase() === m));
  };

  function start() { startP = init(); return startP; }
  async function init() {
    try {
      if (!(await makers.isReady())) return false;
      await makers.query(`CREATE TABLE IF NOT EXISTS mh_channels (chat_id TEXT PRIMARY KEY, title TEXT, username TEXT, added_by BIGINT, added_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const { rows } = await makers.query("SELECT chat_id, title FROM mh_channels");
      rows.forEach(r => cache.set(r.chat_id, r.title || r.chat_id));
      ready = true;
      console.log("Channel registry is on (" + cache.size + " extra channel" + (cache.size === 1 ? "" : "s") + ").");
      return true;
    } catch (e) { log("start failed:", e.message); return false; }
  }

  // Returns "added", "exists", "main" (it is the main channel), "full" or "unavailable".
  async function add({ id, title, username, addedBy }) {
    id = String(id);
    if (isMain(id, username)) return "main";
    if (!(await whenReady())) return "unavailable";
    if (cache.has(id)) { await makers.query("UPDATE mh_channels SET title=$2, username=$3 WHERE chat_id=$1", [id, title || null, username || null]).catch(() => {}); cache.set(id, title || id); return "exists"; }
    if (cache.size >= MAX) return "full";
    await makers.query("INSERT INTO mh_channels(chat_id,title,username,added_by) VALUES($1,$2,$3,$4) ON CONFLICT (chat_id) DO NOTHING", [id, title || null, username || null, addedBy || null]);
    cache.set(id, title || id);
    return "added";
  }

  async function remove(id) {
    id = String(id);
    await whenReady();
    if (!cache.delete(id)) return false;
    await makers.query("DELETE FROM mh_channels WHERE chat_id=$1", [id]).catch(e => log("remove:", e.message));
    return true;
  }

  return { start, add, remove, list: () => [...cache.keys()], titles: () => [...cache.entries()], whenReady, isMain };
};
