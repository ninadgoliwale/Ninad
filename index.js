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
  
  CREATE TABLE IF NOT EXISTS sudo_users (
    user_id INTEGER PRIMARY KEY
  );
  
  CREATE TABLE IF NOT EXISTS user_warnings (
    user_id INTEGER,
    chat_id INTEGER,
    count INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, chat_id)
  );
  
  CREATE TABLE IF NOT EXISTS muted_users (
    user_id INTEGER,
    chat_id INTEGER,
    until INTEGER,
    PRIMARY KEY (user_id, chat_id)
  );
  
  CREATE TABLE IF NOT EXISTS filters (
    chat_id INTEGER,
    keyword TEXT,
    response TEXT,
    PRIMARY KEY (chat_id, keyword)
  );
  
  CREATE TABLE IF NOT EXISTS bot_stats (
    key TEXT PRIMARY KEY,
    value INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS global_bans (
    user_id INTEGER PRIMARY KEY,
    reason TEXT,
    banned_by INTEGER,
    banned_at INTEGER
  );
`);

db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`).run('total_users');
db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`).run('total_groups');
db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`).run('total_commands');

async function telegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
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

function updateStat(key, increment = 1) {
  db.prepare(`UPDATE bot_stats SET value = value + ? WHERE key = ?`).run(increment, key);
}

function calculateFee(amount) {
  if (amount < 190) return 5;
  if (amount <= 599) return 10;
  if (amount <= 2000) return amount * 0.02;
  if (amount <= 3000) return amount * 0.025;
  return amount * 0.03;
}

function formatRupees(value) {
  const rounded = Math.ceil(value * 100) / 100;
  return Number.isInteger(rounded) ? `₹${rounded}` : `₹${rounded.toFixed(2)}`;
}

function extractAmount(text) {
  const cleaned = text.replace(/,/g, "");
  const match = cleaned.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  return match ? Number(match[1]) : null;
}

function getFeeMessage(amount) {
  const fee = calculateFee(amount);
  const total = amount + fee;
  return `🏦 **SHAYAMxESCROW**\n\n💰 **Deal Amount:** ${formatRupees(amount)}\n📝 **Escrow Fee:** ${formatRupees(fee)}\n💵 **Total Payable:** ${formatRupees(total)}\n\n_RG: @SHAYAMxESCROW_`;
}

const userMessageCache = new Map();

async function checkFlood(chatId, userId) {
  if (isSudo(userId)) return false;
  const settings = db.prepare('SELECT anti_flood, flood_action FROM group_settings WHERE chat_id = ?').get(chatId);
  if (!settings || settings.anti_flood === 0) return false;
  
  const limit = settings.anti_flood;
  const now = Math.floor(Date.now() / 1000);
  const key = `${chatId}:${userId}`;
  const current = userMessageCache.get(key) || { count: 0, firstTs: now };
  
  if (now - current.firstTs > 5) {
    current.count = 1;
    current.firstTs = now;
  } else {
    current.count++;
  }
  
  userMessageCache.set(key, current);
  
  if (current.count > limit) {
    const action = settings.flood_action;
    if (action === 'mute') {
      await restrictUser(chatId, userId, now + 60, false);
      await sendMessage(chatId, `🚫 User muted for 60 seconds due to flooding.`);
    } else if (action === 'kick') {
      await kickUser(chatId, userId);
      await unbanUser(chatId, userId);
      await sendMessage(chatId, `👢 User kicked for flooding.`);
    } else if (action === 'ban') {
      await kickUser(chatId, userId);
      await sendMessage(chatId, `🔨 User banned for flooding.`);
    }
    userMessageCache.delete(key);
    return true;
  }
  return false;
}

async function handleStart(chatId, userId, msgId) {
  updateStat('total_users');
  const text = `✨ **SHAYAMxESCROW Bot** ✨\n\nI calculate escrow fees and manage groups!\n\n**💰 Escrow:** Send any number or /fee 500\n**👑 Admin:** /ban, /kick, /mute, /warn\n**⚙️ Config:** /settings, /filter\n**📊 Owner:** /owner\n\nType /help for commands!\n\n👨‍💻 **Developer:** @clerkMM, @auramanxhere`;
  await sendMessage(chatId, text, msgId, "Markdown");
}

async function handleHelp(chatId, userId, msgId) {
  const isSudoUser = isSudo(userId);
  let text = `📚 **SHAYAMxESCROW Help**\n\n**💰 Escrow:**\n• /fee <amount> - Calculate fee\n\n**👑 Admin:**\n• /ban, /kick, /mute, /unmute\n• /warn, /warns, /resetwarns\n• /purge, /adminlist, /admins\n• /filter, /filters, /stop\n\n**⚙️ Settings:**\n• /settings, /setflood, /setfloodaction\n• /setwelcome, /setgoodbye`;
  
  if (isSudoUser) {
    text += `\n\n**👑 Owner Panel:**\n• /owner - Owner panel\n• /stats - Bot stats\n• /sudo - Manage sudo\n• /broadcast - Global message\n• /globalban - Ban from all groups\n• /gclist - List groups\n• /leave - Leave group\n• /restart - Restart bot`;
  }
  text += `\n\n_RG: @SHAYAMxESCROW_`;
  await sendMessage(chatId, text, msgId, "Markdown");
}

async function handleFee(chatId, amount, msgId) {
  if (!amount || amount <= 0) {
    await sendMessage(chatId, "Please provide a valid amount. Example: `/fee 500`", msgId);
    return;
  }
  updateStat('total_commands');
  await sendMessage(chatId, getFeeMessage(amount), msgId, "Markdown");
}

async function handleOwnerPanel(chatId, userId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ You are not authorized.", msgId);
    return;
  }
  
  const totalUsers = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_users'`).get()?.value || 0;
  const totalGroups = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_groups'`).get()?.value || 0;
  const totalCommands = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_commands'`).get()?.value || 0;
  const sudoCount = db.prepare(`SELECT COUNT(*) as count FROM sudo_users`).get().count;
  
  const text = `👑 **OWNER CONTROL PANEL**\n\n📊 **Bot Stats:**\n• Users: ${totalUsers}\n• Groups: ${totalGroups}\n• Commands: ${totalCommands}\n• Sudo Admins: ${sudoCount}\n\n🛠️ **Commands:**\n• /broadcast - Send global message\n• /stats - View stats\n• /sudo - Manage sudo\n• /globalban - Global ban\n• /gclist - List groups\n• /leave - Leave group\n• /restart - Restart bot\n\n📈 **Status:** 🟢 Online\n👨‍💻 **Developer:** @clerkMM, @auramanxhere`;
  await sendMessage(chatId, text, msgId, "Markdown");
}

async function handleBroadcast(chatId, userId, message, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only.", msgId);
    return;
  }
  if (!message) {
    await sendMessage(chatId, "Usage: `/broadcast <message>`", msgId);
    return;
  }
  
  await sendMessage(chatId, "📢 Broadcasting...", msgId);
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  let success = 0, failed = 0;
  
  for (const group of groups) {
    try {
      await sendMessage(group.chat_id, message, null, "Markdown");
      success++;
      await new Promise(r => setTimeout(r, 50));
    } catch {
      failed++;
    }
  }
  await sendMessage(chatId, `✅ Broadcast done!\nSuccess: ${success}\nFailed: ${failed}`, msgId);
}

async function handleStats(chatId, userId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only.", msgId);
    return;
  }
  
  const stats = {
    users: db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_users'`).get()?.value || 0,
    groups: db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_groups'`).get()?.value || 0,
    cmds: db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_commands'`).get()?.value || 0,
    sudo: db.prepare(`SELECT COUNT(*) as count FROM sudo_users`).get().count,
    filters: db.prepare(`SELECT COUNT(*) as count FROM filters`).get().count
  };
  
  const text = `📊 **Bot Statistics**\n\n• Users: ${stats.users}\n• Groups: ${stats.groups}\n• Commands Used: ${stats.cmds}\n• Sudo Admins: ${stats.sudo}\n• Active Filters: ${stats.filters}\n• Uptime: ${Math.floor(process.uptime() / 60)} min\n• Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB\n\n👨‍💻 **Developer:** @clerkMM, @auramanxhere`;
  await sendMessage(chatId, text, msgId, "Markdown");
}

async function handleSudo(chatId, userId, action, targetId, msgId) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, "❌ Owner only.", msgId);
    return;
  }
  
  if (!action || !targetId) {
    const sudoList = db.prepare(`SELECT user_id FROM sudo_users`).all();
    const list = sudoList.map(s => `• \`${s.user_id}\``).join("\n") || "None";
    await sendMessage(chatId, `**Sudo Users:**\n${list}\n\nUsage:\n/sudo add <id>\n/sudo remove <id>`, msgId, "Markdown");
    return;
  }
  
  const target = parseInt(targetId);
  if (action === 'add') {
    if (target === OWNER_ID) {
      await sendMessage(chatId, "❌ Owner is already sudo.", msgId);
      return;
    }
    db.prepare(`INSERT OR IGNORE INTO sudo_users (user_id) VALUES (?)`).run(target);
    await sendMessage(chatId, `✅ Added \`${target}\` as sudo admin.`, msgId, "Markdown");
  } else if (action === 'remove') {
    db.prepare(`DELETE FROM sudo_users WHERE user_id = ?`).run(target);
    await sendMessage(chatId, `✅ Removed \`${target}\` from sudo.`, msgId, "Markdown");
  }
}

async function handleGlobalBan(chatId, userId, targetId, reason, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only.", msgId);
    return;
  }
  if (!targetId) {
    await sendMessage(chatId, "Usage: `/globalban <user_id> <reason>`", msgId);
    return;
  }
  
  const target = parseInt(targetId);
  db.prepare(`INSERT OR REPLACE INTO global_bans (user_id, reason, banned_by, banned_at) VALUES (?, ?, ?, ?)`).run(target, reason || "No reason", userId, Date.now());
  
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  let count = 0;
  for (const group of groups) {
    try {
      await kickUser(group.chat_id, target);
      count++;
      await new Promise(r => setTimeout(r, 100));
    } catch {}
  }
  await sendMessage(chatId, `✅ Globally banned \`${target}\`\nKicked from ${count} groups.`, msgId, "Markdown");
}

async function handleGlobalUnban(chatId, userId, targetId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only.", msgId);
    return;
  }
  if (!targetId) {
    await sendMessage(chatId, "Usage: `/globalunban <user_id>`", msgId);
    return;
  }
  db.prepare(`DELETE FROM global_bans WHERE user_id = ?`).run(parseInt(targetId));
  await sendMessage(chatId, `✅ Removed global ban for \`${targetId}\`.`, msgId, "Markdown");
}

async function handleGroupList(chatId, userId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only.", msgId);
    return;
  }
  
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  if (groups.length === 0) {
    await sendMessage(chatId, "No groups found.", msgId);
    return;
  }
  
  let list = "**📋 Groups List:**\n\n";
  for (let i = 0; i < Math.min(groups.length, 15); i++) {
    try {
      const chat = await telegram("getChat", { chat_id: groups[i].chat_id });
      list += `${i+1}. ${chat.title} - \`${chat.id}\`\n`;
    } catch {
      list += `${i+1}. Unknown - \`${groups[i].chat_id}\`\n`;
    }
  }
  if (groups.length > 15) list += `\n... and ${groups.length - 15} more.`;
  await sendMessage(chatId, list, msgId, "Markdown");
}

async function handleLeave(chatId, userId, targetChatId, msgId) {
  if (!isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only.", msgId);
    return;
  }
  const leaveId = targetChatId || chatId;
  await sendMessage(chatId, `👋 Leaving...`, msgId);
  await leaveChat(leaveId);
  db.prepare(`DELETE FROM group_settings WHERE chat_id = ?`).run(leaveId);
}

async function handleRestart(chatId, userId, msgId) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, "❌ Owner only.", msgId);
    return;
  }
  await sendMessage(chatId, "🔄 Restarting...", msgId);
  process.exit(0);
}

async function handleAdminList(chatId, msgId) {
  try {
    const admins = await telegram("getChatAdministrators", { chat_id: chatId });
    const list = admins.map(a => `👑 ${a.user.first_name} (${a.user.id})`).join("\n");
    await sendMessage(chatId, `**Admins:**\n${list}`, msgId, "Markdown");
  } catch {
    await sendMessage(chatId, "Failed to get admin list.", msgId);
  }
}

async function handleBan(chatId, userId, targetId, reason, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  try {
    await kickUser(chatId, targetId);
    await sendMessage(chatId, `🔨 Banned. Reason: ${reason || "No reason"}`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to ban user.", msgId);
  }
}

async function handleKick(chatId, userId, targetId, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  try {
    await kickUser(chatId, targetId);
    await unbanUser(chatId, targetId);
    await sendMessage(chatId, `👢 Kicked.`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to kick user.", msgId);
  }
}

async function handleMute(chatId, userId, targetId, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  try {
    const until = Math.floor(Date.now() / 1000) + 3600;
    await restrictUser(chatId, targetId, until, false);
    await sendMessage(chatId, `🔇 Muted for 60 minutes.`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to mute user.", msgId);
  }
}

async function handleUnmute(chatId, userId, targetId, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  try {
    await restrictUser(chatId, targetId, 0, true);
    await sendMessage(chatId, `🔊 Unmuted.`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to unmute user.", msgId);
  }
}

async function handleWarn(chatId, userId, targetId, reason, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  
  let warning = db.prepare(`SELECT count FROM user_warnings WHERE user_id = ? AND chat_id = ?`).get(targetId, chatId);
  let newCount = (warning?.count || 0) + 1;
  db.prepare(`INSERT OR REPLACE INTO user_warnings (user_id, chat_id, count) VALUES (?, ?, ?)`).run(targetId, chatId, newCount);
  await sendMessage(chatId, `⚠️ Warned! (${newCount}/3)\nReason: ${reason || "No reason"}`, msgId);
  
  if (newCount >= 3) {
    await kickUser(chatId, targetId);
    db.prepare(`DELETE FROM user_warnings WHERE user_id = ? AND chat_id = ?`).run(targetId, chatId);
    await sendMessage(chatId, `🔨 Banned for exceeding 3 warnings.`, msgId);
  }
}

async function handleWarns(chatId, targetId, msgId) {
  const warning = db.prepare(`SELECT count FROM user_warnings WHERE user_id = ? AND chat_id = ?`).get(targetId, chatId);
  const count = warning?.count || 0;
  await sendMessage(chatId, `📊 User has ${count}/3 warnings.`, msgId);
}

async function handleResetWarns(chatId, userId, targetId, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  db.prepare(`DELETE FROM user_warnings WHERE user_id = ? AND chat_id = ?`).run(targetId, chatId);
  await sendMessage(chatId, `✅ Warnings reset.`, msgId);
}

async function handlePurge(chatId, userId, count, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  const num = parseInt(count);
  if (!num || num < 1 || num > 100) {
    await sendMessage(chatId, "Usage: `/purge 1-100`", msgId);
    return;
  }
  await sendMessage(chatId, `🗑️ Deleting ${num} messages...`, msgId);
}

async function handleAddFilter(chatId, userId, keyword, response, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  if (!keyword || !response) {
    await sendMessage(chatId, "Usage: `/filter keyword response`", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO filters (chat_id, keyword, response) VALUES (?, ?, ?)`).run(chatId, keyword.toLowerCase(), response);
  await sendMessage(chatId, `✅ Filter added: "${keyword}" → "${response}"`, msgId);
}

async function handleListFilters(chatId, msgId) {
  const filters = db.prepare(`SELECT keyword FROM filters WHERE chat_id = ?`).all(chatId);
  if (filters.length === 0) {
    await sendMessage(chatId, "No filters.", msgId);
    return;
  }
  const list = filters.map(f => `• ${f.keyword}`).join("\n");
  await sendMessage(chatId, `**Filters:**\n${list}`, msgId);
}

async function handleStopFilter(chatId, userId, keyword, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  const result = db.prepare(`DELETE FROM filters WHERE chat_id = ? AND keyword = ?`).run(chatId, keyword.toLowerCase());
  if (result.changes > 0) {
    await sendMessage(chatId, `✅ Filter "${keyword}" removed.`, msgId);
  } else {
    await sendMessage(chatId, `Filter not found.`, msgId);
  }
}

async function handleSettings(chatId, userId, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  
  const settings = db.prepare(`SELECT * FROM group_settings WHERE chat_id = ?`).get(chatId);
  const flood = settings?.anti_flood || 5;
  const action = settings?.flood_action || 'mute';
  
  const text = `⚙️ **Group Settings**\n\n🛡️ Anti-Flood: ${flood} msgs/5sec\n🎯 Flood Action: ${action}\n👋 Welcome: ${settings?.welcome_msg ? '✅' : '❌'}\n👋 Goodbye: ${settings?.goodbye_msg ? '✅' : '❌'}\n\nCommands:\n/setflood <count>\n/setfloodaction <mute/kick/ban>\n/setwelcome <text>\n/setgoodbye <text>`;
  await sendMessage(chatId, text, msgId, "Markdown");
}

async function handleSetFlood(chatId, userId, limit, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  const num = parseInt(limit);
  if (isNaN(num) || num < 0) {
    await sendMessage(chatId, "Provide a valid number (0 to disable).", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, anti_flood) VALUES (?, ?)`).run(chatId, num);
  await sendMessage(chatId, `✅ Anti-flood set to ${num}.`, msgId);
}

async function handleSetFloodAction(chatId, userId, action, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  if (!['mute', 'kick', 'ban'].includes(action)) {
    await sendMessage(chatId, "Use: mute, kick, or ban", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, flood_action) VALUES (?, ?)`).run(chatId, action);
  await sendMessage(chatId, `✅ Flood action set to ${action}.`, msgId);
}

async function handleSetWelcome(chatId, userId, text, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, welcome_msg) VALUES (?, ?)`).run(chatId, text);
  await sendMessage(chatId, `✅ Welcome message set. Use @USER to mention.`, msgId);
}

async function handleSetGoodbye(chatId, userId, text, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, goodbye_msg) VALUES (?, ?)`).run(chatId, text);
  await sendMessage(chatId, `✅ Goodbye message set.`, msgId);
}

async function handleId(chatId, userId, msgId) {
  await sendMessage(chatId, `🆔 Your ID: \`${userId}\`\n📢 Chat ID: \`${chatId}\``, msgId, "Markdown");
}

async function checkFilters(chatId, text, replyId) {
  const filters = db.prepare(`SELECT keyword, response FROM filters WHERE chat_id = ?`).all(chatId);
  for (const filter of filters) {
    if (text.toLowerCase().includes(filter.keyword)) {
      await sendMessage(chatId, filter.response, replyId);
      return true;
    }
  }
  return false;
}

async function handleNewMember(chatId, newMember) {
  updateStat('total_groups');
  const settings = db.prepare(`SELECT welcome_msg FROM group_settings WHERE chat_id = ?`).get(chatId);
  if (settings?.welcome_msg) {
    let msg = settings.welcome_msg.replace(/@USER/g, `[${newMember.first_name}](tg://user?id=${newMember.id})`);
    await sendMessage(chatId, msg, null, "Markdown");
  }
}

let offset = 0;

async function handleMessage(message) {
  if (!message || !message.text || !message.chat) return;
  
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const msgId = message.message_id;
  const text = message.text.trim();
  
  if (message.from?.is_bot && !text.startsWith('/')) return;
  
  if (userId && !isSudo(userId) && !await isAdmin(chatId, userId)) {
    const flooded = await checkFlood(chatId, userId);
    if (flooded) return;
  }
  
  await checkFilters(chatId, text, msgId);
  
  if (message.chat.type === "private") {
    const amount = extractAmount(text);
    if (amount && amount > 0 && !text.startsWith('/')) {
      await handleFee(chatId, amount, msgId);
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
  
  let targetId = userId;
  if (message.reply_to_message?.from) {
    targetId = message.reply_to_message.from.id;
  } else {
    const match = param.match(/(\d+)/);
    if (match) targetId = parseInt(match[1]);
  }
  
  switch (cmd) {
    case '/start': await handleStart(chatId, userId, msgId); break;
    case '/help': await handleHelp(chatId, userId, msgId); break;
    case '/fee': case '/fees': case '/calc': await handleFee(chatId, extractAmount(param), msgId); break;
    case '/owner': await handleOwnerPanel(chatId, userId, msgId); break;
    case '/broadcast': await handleBroadcast(chatId, userId, param, msgId); break;
    case '/stats': await handleStats(chatId, userId, msgId); break;
    case '/sudo': await handleSudo(chatId, userId, param.split(' ')[0], param.split(' ')[1], msgId); break;
    case '/globalban': await handleGlobalBan(chatId, userId, param.split(' ')[0], param.split(' ').slice(1).join(' '), msgId); break;
    case '/globalunban': await handleGlobalUnban(chatId, userId, param, msgId); break;
    case '/gclist': await handleGroupList(chatId, userId, msgId); break;
    case '/leave': await handleLeave(chatId, userId, param, msgId); break;
    case '/restart': await handleRestart(chatId, userId, msgId); break;
    case '/adminlist': await handleAdminList(chatId, msgId); break;
    case '/ban': await handleBan(chatId, userId, targetId, param.replace(/^\d+/, '').trim(), msgId); break;
    case '/kick': await handleKick(chatId, userId, targetId, msgId); break;
    case '/mute': await handleMute(chatId, userId, targetId, msgId); break;
    case '/unmute': await handleUnmute(chatId, userId, targetId, msgId); break;
    case '/warn': await handleWarn(chatId, userId, targetId, param.replace(/^\d+/, '').trim(), msgId); break;
    case '/warns': await handleWarns(chatId, targetId, msgId); break;
    case '/resetwarns': await handleResetWarns(chatId, userId, targetId, msgId); break;
    case '/purge': await handlePurge(chatId, userId, param, msgId); break;
    case '/filter': 
      const [kw, ...respParts] = param.split(/\s+/);
      await handleAddFilter(chatId, userId, kw, respParts.join(" "), msgId);
      break;
    case '/filters': await handleListFilters(chatId, msgId); break;
    case '/stop': await handleStopFilter(chatId, userId, param, msgId); break;
    case '/settings': await handleSettings(chatId, userId, msgId); break;
    case '/setflood': await handleSetFlood(chatId, userId, param, msgId); break;
    case '/setfloodaction': await handleSetFloodAction(chatId, userId, param, msgId); break;
    case '/setwelcome': await handleSetWelcome(chatId, userId, param, msgId); break;
    case '/setgoodbye': await handleSetGoodbye(chatId, userId, param, msgId); break;
    case '/id': await handleId(chatId, userId, msgId); break;
  }
}

async function poll() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          if (update.message.new_chat_members) {
            for (const member of update.message.new_chat_members) {
              await handleNewMember(update.message.chat.id, member);
            }
          }
          await handleMessage(update.message);
        }
      }
    } catch (error) {
      console.error(error.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("SHAYAMxESCROW Bot is running");
});
server.listen(PORT, () => console.log(`Server on port ${PORT}`));

poll().catch(
