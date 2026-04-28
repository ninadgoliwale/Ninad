import http from 'http';
import Database from 'better-sqlite3';

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN required");
if (!OWNER_ID) throw new Error("OWNER_ID required");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const db = new Database('bot_data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS group_settings (
    chat_id INTEGER PRIMARY KEY,
    welcome_msg TEXT,
    goodbye_msg TEXT,
    anti_flood INTEGER DEFAULT 5,
    flood_action TEXT DEFAULT 'mute'
  );
  CREATE TABLE IF NOT EXISTS sudo_users (user_id INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS user_warnings (user_id INTEGER, chat_id INTEGER, count INTEGER DEFAULT 0, PRIMARY KEY (user_id, chat_id));
  CREATE TABLE IF NOT EXISTS muted_users (user_id INTEGER, chat_id INTEGER, until INTEGER, PRIMARY KEY (user_id, chat_id));
  CREATE TABLE IF NOT EXISTS filters (chat_id INTEGER, keyword TEXT, response TEXT, PRIMARY KEY (chat_id, keyword));
  CREATE TABLE IF NOT EXISTS bot_stats (key TEXT PRIMARY KEY, value INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS global_bans (user_id INTEGER PRIMARY KEY, reason TEXT, banned_by INTEGER, banned_at INTEGER);
`);

db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`).run('total_users');
db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`).run('total_groups');
db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`).run('total_commands');

async function telegram(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed`);
  return data.result;
}

async function sendMessage(chatId, text, replyToMessageId = null, parseMode = null) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  if (parseMode) payload.parse_mode = parseMode;
  return telegram("sendMessage", payload);
}

async function kickUser(chatId, userId) {
  return telegram("banChatMember", { chat_id: chatId, user_id: userId });
}

async function unbanUser(chatId, userId) {
  return telegram("unbanChatMember", { chat_id: chatId, user_id: userId });
}

async function restrictUser(chatId, userId, untilDate, canSendMessages = false) {
  return telegram("restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    until_date: untilDate,
    permissions: { can_send_messages: canSendMessages }
  });
}

async function leaveChat(chatId) {
  return telegram("leaveChat", { chat_id: chatId });
}

function isSudo(userId) {
  if (userId === OWNER_ID) return true;
  const sudo = db.prepare(`SELECT user_id FROM sudo_users WHERE user_id = ?`).get(userId);
  return !!sudo;
}

async function isAdmin(chatId, userId) {
  if (userId === OWNER_ID) return true;
  if (isSudo(userId)) return true;
  try {
    const member = await telegram("getChatMember", { chat_id: chatId, user_id: userId });
    return ['creator', 'administrator'].includes(member.status);
  } catch {
    return false;
  }
}

function updateStat(key, inc = 1) {
  db.prepare(`UPDATE bot_stats SET value = value + ? WHERE key = ?`).run(inc, key);
}

function calculateFee(amount) {
  if (amount < 190) return 5;
  if (amount <= 599) return 10;
  if (amount <= 2000) return amount * 0.02;
  if (amount <= 3000) return amount * 0.025;
  return amount * 0.03;
}

function formatRupees(val) {
  const r = Math.ceil(val * 100) / 100;
  return Number.isInteger(r) ? `₹${r}` : `₹${r.toFixed(2)}`;
}

function extractAmount(text) {
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  return match ? Number(match[1]) : null;
}

function getFeeMessage(amount) {
  const fee = calculateFee(amount);
  const total = amount + fee;
  return `🏦 **SHAYAMxESCROW**\n\n💰 Deal Amount: ${formatRupees(amount)}\n📝 Escrow Fee: ${formatRupees(fee)}\n💵 Total Payable: ${formatRupees(total)}\n\n_RG: @SHAYAMxESCROW_`;
}

const msgCache = new Map();

async function checkFlood(chatId, userId) {
  if (isSudo(userId)) return false;
  const s = db.prepare('SELECT anti_flood, flood_action FROM group_settings WHERE chat_id = ?').get(chatId);
  if (!s || s.anti_flood === 0) return false;
  
  const now = Math.floor(Date.now() / 1000);
  const key = `${chatId}:${userId}`;
  const cur = msgCache.get(key) || { count: 0, firstTs: now };
  
  if (now - cur.firstTs > 5) {
    cur.count = 1;
    cur.firstTs = now;
  } else {
    cur.count++;
  }
  msgCache.set(key, cur);
  
  if (cur.count > s.anti_flood) {
    if (s.flood_action === 'mute') {
      await restrictUser(chatId, userId, now + 60, false);
      await sendMessage(chatId, `🚫 Muted for 60s (flooding)`);
    } else if (s.flood_action === 'kick') {
      await kickUser(chatId, userId);
      await unbanUser(chatId, userId);
      await sendMessage(chatId, `👢 Kicked for flooding`);
    } else if (s.flood_action === 'ban') {
      await kickUser(chatId, userId);
      await sendMessage(chatId, `🔨 Banned for flooding`);
    }
    msgCache.delete(key);
    return true;
  }
  return false;
}

async function handleStart(chatId, userId, msgId) {
  updateStat('total_users');
  const txt = `✨ **SHAYAMxESCROW Bot** ✨\n\n💰 Send any number or /fee 500\n👑 /ban, /kick, /mute, /warn\n⚙️ /settings, /filter\n📊 /owner (owner only)\n\n👨‍💻 @clerkMM, @auramanxhere`;
  await sendMessage(chatId, txt, msgId, "Markdown");
}

async function handleHelp(chatId, userId, msgId) {
  let txt = `📚 **Commands**\n\n💰 /fee <amt>\n👑 /ban, /kick, /mute, /unmute, /warn, /warns, /resetwarns, /purge, /adminlist\n⚙️ /settings, /setflood, /setwelcome, /filter, /filters, /stop`;
  if (isSudo(userId)) txt += `\n\n👑 **Owner:** /owner, /stats, /sudo, /broadcast, /globalban, /gclist, /leave, /restart`;
  txt += `\n\n_RG: @SHAYAMxESCROW_`;
  await sendMessage(chatId, txt, msgId, "Markdown");
}

async function handleFee(chatId, amt, msgId) {
  if (!amt || amt <= 0) {
    await sendMessage(chatId, "Usage: `/fee 500`", msgId);
    return;
  }
  updateStat('total_commands');
  await sendMessage(chatId, getFeeMessage(amt), msgId, "Markdown");
}

async function handleOwner(chatId, userId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Unauthorized", msgId);
    return;
  }
  const users = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_users'`).get()?.value || 0;
  const groups = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_groups'`).get()?.value || 0;
  const cmds = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_commands'`).get()?.value || 0;
  const sudoCnt = db.prepare(`SELECT COUNT(*) as c FROM sudo_users`).get().c;
  const txt = `👑 **Owner Panel**\n\n📊 Users: ${users}\n📊 Groups: ${groups}\n📊 Commands: ${cmds}\n👑 Sudo: ${sudoCnt}\n\n🛠️ /stats, /sudo, /broadcast, /globalban, /gclist, /leave, /restart\n\n👨‍💻 @clerkMM, @auramanxhere`;
  await sendMessage(chatId, txt, msgId, "Markdown");
}

async function handleStats(chatId, userId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only", msgId);
    return;
  }
  const u = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_users'`).get()?.value || 0;
  const g = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_groups'`).get()?.value || 0;
  const c = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_commands'`).get()?.value || 0;
  const s = db.prepare(`SELECT COUNT(*) as c FROM sudo_users`).get().c;
  const f = db.prepare(`SELECT COUNT(*) as c FROM filters`).get().c;
  const txt = `📊 **Stats**\n\n👤 Users: ${u}\n👥 Groups: ${g}\n⚡ Commands: ${c}\n👑 Sudo: ${s}\n🔍 Filters: ${f}\n⏱️ Uptime: ${Math.floor(process.uptime() / 60)}m\n💾 Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`;
  await sendMessage(chatId, txt, msgId, "Markdown");
}

async function handleSudo(chatId, userId, action, target, msgId) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, "❌ Owner only", msgId);
    return;
  }
  if (!action || !target) {
    const list = db.prepare(`SELECT user_id FROM sudo_users`).all();
    const l = list.map(x => `• \`${x.user_id}\``).join("\n") || "None";
    await sendMessage(chatId, `**Sudo Users**\n${l}\n\n/sudo add <id>\n/sudo remove <id>`, msgId, "Markdown");
    return;
  }
  const tid = parseInt(target);
  if (action === 'add') {
    if (tid === OWNER_ID) {
      await sendMessage(chatId, "❌ Owner is already sudo", msgId);
      return;
    }
    db.prepare(`INSERT OR IGNORE INTO sudo_users (user_id) VALUES (?)`).run(tid);
    await sendMessage(chatId, `✅ Added \`${tid}\``, msgId, "Markdown");
  } else if (action === 'remove') {
    db.prepare(`DELETE FROM sudo_users WHERE user_id = ?`).run(tid);
    await sendMessage(chatId, `✅ Removed \`${tid}\``, msgId, "Markdown");
  }
}

async function handleBroadcast(chatId, userId, msg, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only", msgId);
    return;
  }
  if (!msg) {
    await sendMessage(chatId, "Usage: `/broadcast <message>`", msgId);
    return;
  }
  await sendMessage(chatId, "📢 Broadcasting...", msgId);
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  let ok = 0, fail = 0;
  for (const g of groups) {
    try {
      await sendMessage(g.chat_id, msg, null, "Markdown");
      ok++;
      await new Promise(r => setTimeout(r, 50));
    } catch { fail++; }
  }
  await sendMessage(chatId, `✅ Done\n✅ ${ok} ✅ ${fail} ❌`, msgId);
}

async function handleGlobalBan(chatId, userId, target, reason, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only", msgId);
    return;
  }
  if (!target) {
    await sendMessage(chatId, "Usage: `/globalban <user_id> <reason>`", msgId);
    return;
  }
  const tid = parseInt(target);
  db.prepare(`INSERT OR REPLACE INTO global_bans (user_id, reason, banned_by, banned_at) VALUES (?, ?, ?, ?)`).run(tid, reason || "No reason", userId, Date.now());
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  let count = 0;
  for (const g of groups) {
    try {
      await kickUser(g.chat_id, tid);
      count++;
      await new Promise(r => setTimeout(r, 100));
    } catch {}
  }
  await sendMessage(chatId, `✅ Globally banned \`${tid}\`\nKicked from ${count} groups`, msgId, "Markdown");
}

async function handleGroupList(chatId, userId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only", msgId);
    return;
  }
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  if (groups.length === 0) {
    await sendMessage(chatId, "No groups", msgId);
    return;
  }
  let txt = "**📋 Groups**\n\n";
  for (let i = 0; i < Math.min(groups.length, 15); i++) {
    try {
      const chat = await telegram("getChat", { chat_id: groups[i].chat_id });
      txt += `${i+1}. ${chat.title} - \`${chat.id}\`\n`;
    } catch {
      txt += `${i+1}. Unknown - \`${groups[i].chat_id}\`\n`;
    }
  }
  if (groups.length > 15) txt += `\n... and ${groups.length - 15} more`;
  await sendMessage(chatId, txt, msgId, "Markdown");
}

async function handleLeave(chatId, userId, target, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only", msgId);
    return;
  }
  const lid = target || chatId;
  await sendMessage(chatId, `👋 Leaving...`, msgId);
  await leaveChat(lid);
  db.prepare(`DELETE FROM group_settings WHERE chat_id = ?`).run(lid);
}

async function handleRestart(chatId, userId, msgId) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, "❌ Owner only", msgId);
    return;
  }
  await sendMessage(chatId, "🔄 Restarting...", msgId);
  process.exit(0);
}

async function handleAdminList(chatId, msgId) {
  try {
    const admins = await telegram("getChatAdministrators", { chat_id: chatId });
    const list = admins.map(a => `👑 ${a.user.first_name} (${a.user.id})`).join("\n");
    await sendMessage(chatId, `**Admins**\n${list}`, msgId, "Markdown");
  } catch {
    await sendMessage(chatId, "Failed to get admins", msgId);
  }
}

async function handleBan(chatId, userId, target, reason, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  try {
    await kickUser(chatId, target);
    await sendMessage(chatId, `🔨 Banned. Reason: ${reason || "No reason"}`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to ban", msgId);
  }
}

async function handleKick(chatId, userId, target, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  try {
    await kickUser(chatId, target);
    await unbanUser(chatId, target);
    await sendMessage(chatId, `👢 Kicked`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to kick", msgId);
  }
}

async function handleMute(chatId, userId, target, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  try {
    const until = Math.floor(Date.now() / 1000) + 3600;
    await restrictUser(chatId, target, until, false);
    await sendMessage(chatId, `🔇 Muted for 60 minutes`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to mute", msgId);
  }
}

async function handleUnmute(chatId, userId, target, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  try {
    await restrictUser(chatId, target, 0, true);
    await sendMessage(chatId, `🔊 Unmuted`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to unmute", msgId);
  }
}

async function handleWarn(chatId, userId, target, reason, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  let w = db.prepare(`SELECT count FROM user_warnings WHERE user_id = ? AND chat_id = ?`).get(target, chatId);
  let cnt = (w?.count || 0) + 1;
  db.prepare(`INSERT OR REPLACE INTO user_warnings (user_id, chat_id, count) VALUES (?, ?, ?)`).run(target, chatId, cnt);
  await sendMessage(chatId, `⚠️ Warned (${cnt}/3)\nReason: ${reason || "No reason"}`, msgId);
  if (cnt >= 3) {
    await kickUser(chatId, target);
    db.prepare(`DELETE FROM user_warnings WHERE user_id = ? AND chat_id = ?`).run(target, chatId);
    await sendMessage(chatId, `🔨 Banned for 3 warnings`, msgId);
  }
}

async function handleWarns(chatId, target, msgId) {
  const w = db.prepare(`SELECT count FROM user_warnings WHERE user_id = ? AND chat_id = ?`).get(target, chatId);
  const cnt = w?.count || 0;
  await sendMessage(chatId, `📊 ${cnt}/3 warnings`, msgId);
}

async function handleResetWarns(chatId, userId, target, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  db.prepare(`DELETE FROM user_warnings WHERE user_id = ? AND chat_id = ?`).run(target, chatId);
  await sendMessage(chatId, `✅ Warnings reset`, msgId);
}

async function handlePurge(chatId, userId, count, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  const c = parseInt(count);
  if (!c || c < 1 || c > 100) {
    await sendMessage(chatId, "Usage: `/purge 1-100`", msgId);
    return;
  }
  await sendMessage(chatId, `🗑️ Deleting ${c} messages...`, msgId);
}

async function handleFilter(chatId, userId, keyword, response, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  if (!keyword || !response) {
    await sendMessage(chatId, "Usage: `/filter word response`", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO filters (chat_id, keyword, response) VALUES (?, ?, ?)`).run(chatId, keyword.toLowerCase(), response);
  await sendMessage(chatId, `✅ Filter: "${keyword}" → "${response}"`, msgId);
}

async function handleFilters(chatId, msgId) {
  const f = db.prepare(`SELECT keyword FROM filters WHERE chat_id = ?`).all(chatId);
  if (f.length === 0) {
    await sendMessage(chatId, "No filters", msgId);
    return;
  }
  const list = f.map(x => `• ${x.keyword}`).join("\n");
  await sendMessage(chatId, `**Filters**\n${list}`, msgId);
}

async function handleStop(chatId, userId, keyword, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  const res = db.prepare(`DELETE FROM filters WHERE chat_id = ? AND keyword = ?`).run(chatId, keyword.toLowerCase());
  if (res.changes > 0) {
    await sendMessage(chatId, `✅ Removed "${keyword}"`, msgId);
  } else {
    await sendMessage(chatId, "Filter not found", msgId);
  }
}

async function handleSettings(chatId, userId, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  const s = db.prepare(`SELECT * FROM group_settings WHERE chat_id = ?`).get(chatId);
  const flood = s?.anti_flood || 5;
  const action = s?.flood_action || 'mute';
  const txt = `⚙️ **Settings**\n\n🛡️ Flood: ${flood}/5s\n🎯 Action: ${action}\n👋 Welcome: ${s?.welcome_msg ? '✅' : '❌'}\n👋 Goodbye: ${s?.goodbye_msg ? '✅' : '❌'}\n\n/setflood <num>\n/setfloodaction <mute/kick/ban>\n/setwelcome <text>\n/setgoodbye <text>`;
  await sendMessage(chatId, txt, msgId, "Markdown");
}

async function handleSetFlood(chatId, userId, limit, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  const num = parseInt(limit);
  if (isNaN(num) || num < 0) {
    await sendMessage(chatId, "Provide a number (0 to disable)", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, anti_flood) VALUES (?, ?)`).run(chatId, num);
  await sendMessage(chatId, `✅ Flood limit: ${num}`, msgId);
}

async function handleSetFloodAction(chatId, userId, action, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  if (!['mute', 'kick', 'ban'].includes(action)) {
    await sendMessage(chatId, "Use: mute, kick, or ban", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, flood_action) VALUES (?, ?)`).run(chatId, action);
  await sendMessage(chatId, `✅ Flood action: ${action}`, msgId);
}

async function handleSetWelcome(chatId, userId, text, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, welcome_msg) VALUES (?, ?)`).run(chatId, text);
  await sendMessage(chatId, `✅ Welcome message set. Use @USER for mention`, msgId);
}

async function handleSetGoodbye(chatId, userId, text, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, goodbye_msg) VALUES (?, ?)`).run(chatId, text);
  await sendMessage(chatId, `✅ Goodbye message set`, msgId);
}

async function handleId(chatId, userId, msgId) {
  await sendMessage(chatId, `🆔 Your ID: \`${userId}\`\n📢 Chat ID: \`${chatId}\``, msgId, "Markdown");
}

async function checkFilters(chatId, text, replyId) {
  const filters = db.prepare(`SELECT keyword, response FROM filters WHERE chat_id = ?`).all(chatId);
  for (const f of filters) {
    if (text.toLowerCase().includes(f.keyword)) {
      await sendMessage(chatId, f.response, replyId);
      return true;
    }
  }
  return false;
}

async function handleNewMember(chatId, member) {
  updateStat('total_groups');
  const s = db.prepare(`SELECT welcome_msg FROM group_settings WHERE chat_id = ?`).get(chatId);
  if (s?.welcome_msg) {
    let msg = s.welcome_msg.replace(/@USER/g, `[${member.first_name}](tg://user?id=${member.id})`);
    await sendMessage(chatId, msg, null, "Markdown");
  }
}

let offset = 0;

async function handleMessage(msg) {
  if (!msg || !msg.text || !msg.chat) return;
  
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const msgId = msg.message_id;
  const text = msg.text.trim();
  
  if (msg.from?.is_bot && !text.startsWith('/')) return;
  
  if (userId && !isSudo(userId) && !await isAdmin(chatId, userId)) {
    if (await checkFlood(chatId, userId)) return;
  }
  
  await checkFilters(chatId, text, msgId);
  
  if (msg.chat.type === "private") {
    const amt = extractAmount(text);
    if (amt && amt > 0 && !text.startsWith('/')) {
      await handleFee(chatId, amt, msgId);
      return;
    }
  }
  
  let cmd = text.toLowerCase();
  let param = "";
  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    cmd = parts[0].toLowerCase();
    param = parts.slice(1).join(" ");
  }
  
  let target = userId;
  if (msg.reply_to_message?.from) {
    target = msg.reply_to_message.from.id;
  } else {
    const match = param.match(/(\d+)/);
    if (match) target = parseInt(match[1]);
  }
  
  switch (cmd) {
    case '/start': await handleStart(chatId, userId, msgId); break;
    case '/help': await handleHelp(chatId, userId, msgId); break;
    case '/fee': case '/fees': case '/calc': await handleFee(chatId, extractAmount(param), msgId); break;
    case '/owner': await handleOwner(chatId, userId, msgId); break;
    case '/stats': await handleStats(chatId, userId, msgId); break;
    case '/sudo': await handleSudo(chatId, userId, param.split(' ')[0], param.split(' ')[1], msgId); break;
    case '/broadcast': await handleBroadcast(chatId, userId, param, msgId); break;
    case '/globalban': await handleGlobalBan(chatId, userId, param.split(' ')[0], param.split(' ').slice(1).join(' '), msgId); break;
    case '/gclist': await handleGroupList(chatId, userId, msgId); break;
    case '/leave': await handleLeave(chatId, userId, param, msgId); break;
    case '/restart': await handleRestart(chatId, userId, msgId); break;
    case '/adminlist': await handleAdminList(chatId, msgId); break;
    case '/ban': await handleBan(chatId, userId, target, param.replace(/^\d+/, '').trim(), msgId); break;
    case '/kick': await handleKick(chatId, userId, target, msgId); break;
    case '/mute': await handleMute(chatId, userId, target, msgId); break;
    case '/unmute': await handleUnmute(chatId, userId, target, msgId); break;
    case '/warn': await handleWarn(chatId, userId, target, param.replace(/^\d+/, '').trim(), msgId); break;
    case '/warns': await handleWarns(chatId, target, msgId); break;
    case '/resetwarns': await handleResetWarns(chatId, userId, target, msgId); break;
    case '/purge': await handlePurge(chatId, userId, param, msgId); break;
    case '/filter': {
      const [kw, ...rest] = param.split(/\s+/);
      await handleFilter(chatId, userId, kw, rest.join(" "), msgId);
      break;
    }
    case '/filters': await handleFilters(chatId, msgId); break;
    case '/stop': await handleStop(chatId, userId, param, msgId); break;
    case '/settings': await handleSettings(chatId, userId, msgId); break;
    case '/setflood': await handleSetFlood(chatId, userId, param, msgId); break;
    case '/setfloodaction': await handleSetFloodAction(chatId, userId, param, msgId); break;
    case '/setwelcome': await handleSetWelcome(chatId, userId, param, msgId); break;
    case '/setgoodbye': await handleSetGoodbye(chatId, userId, param, msgId); break;
    case '/id': await handleId(chatId, userId, msgId); break;
  }
}

async function pollUpdates() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          if (update.message.new_chat_members) {
            for (const m of update.message.new_chat_members) {
              await handleNewMember(update.message.chat.id, m);
            }
          }
          await handleMessage(update.message);
        }
      }
    } catch (err) {
      console.error(err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SHAYAMxESCROW Bot is running");
});
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

pollUpdates();