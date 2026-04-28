import http from 'http';
import Database from 'better-sqlite3';

// ============ CONFIGURATION ============
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID);
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN required");
if (!OWNER_ID) throw new Error("OWNER_ID required");

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ============ DATABASE SETUP ============
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
  
  CREATE TABLE IF NOT EXISTS message_tracker (
    user_id INTEGER,
    chat_id INTEGER,
    count INTEGER DEFAULT 1,
    first_ts INTEGER,
    PRIMARY KEY (user_id, chat_id)
  );
  
  CREATE TABLE IF NOT EXISTS banned_users (
    user_id INTEGER,
    chat_id INTEGER,
    reason TEXT,
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
  
  CREATE TABLE IF NOT EXISTS approved_groups (
    chat_id INTEGER PRIMARY KEY,
    added_by INTEGER,
    added_at INTEGER
  );
`);

// Initialize stats
const statsInit = db.prepare(`INSERT OR IGNORE INTO bot_stats (key, value) VALUES (?, 0)`);
statsInit.run('total_users');
statsInit.run('total_groups');
statsInit.run('total_commands');

// ============ HELPER FUNCTIONS ============
async function telegram(method, payload) {
  const response = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method} failed: ${JSON.stringify(data)}`);
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

// ============ ESCROW FEE CALCULATION ============
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
  return [
    `🏦 **SHAYAMxESCROW**`,
    ``,
    `💰 **Deal Amount:** ${formatRupees(amount)}`,
    `📝 **Escrow Fee:** ${formatRupees(fee)}`,
    `💵 **Total Payable:** ${formatRupees(total)}`,
    ``,
    `_RG: @SHAYAMxESCROW_`
  ].join("\n");
}

// ============ ANTI-FLOOD SYSTEM ============
const userMessageCache = new Map();

async function checkFlood(chatId, userId, messageId) {
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
      await sendMessage(chatId, `🚫 User has been muted for 60 seconds due to flooding.`);
    } else if (action === 'kick') {
      await kickUser(chatId, userId);
      await unbanUser(chatId, userId);
      await sendMessage(chatId, `👢 User has been kicked for flooding.`);
    } else if (action === 'ban') {
      await kickUser(chatId, userId);
      await sendMessage(chatId, `🔨 User has been banned for flooding.`);
    }
    userMessageCache.delete(key);
    return true;
  }
  return false;
}

// ============ COMMAND HANDLERS ============

async function handleStart(chatId, userId, msgId) {
  updateStat('total_users');
  
  const welcomeText = [
    `✨ **SHAYAMxESCROW Bot** ✨`,
    ``,
    `I calculate escrow fees and manage groups like MissRose!`,
    ``,
    `**💰 Escrow:** Send any number or /fee 500`,
    `**👑 Admin:** /ban, /kick, /mute, /warn, /purge`,
    `**⚙️ Config:** /settings, /filter, /setflood`,
    `**📊 Owner:** /owner`,
    ``,
    `Type /help for complete command list!`,
    ``,
    `👨‍💻 **Developer:** @clerkMM, @auramanxhere`
  ].join("\n");
  await sendMessage(chatId, welcomeText, msgId, "Markdown");
}

async function handleHelp(chatId, userId, msgId) {
  const isSudoUser = isSudo(userId);
  
  let helpText = [
    `📚 **SHAYAMxESCROW Help**`,
    ``,
    `**💰 Escrow:**`,
    `• /fee <amount> - Calculate fee`,
    ``,
    `**👑 Admin:**`,
    `• /ban, /kick, /mute, /unmute`,
    `• /warn, /warns, /resetwarns`,
    `• /purge, /adminlist, /admins`,
    `• /filter, /filters, /stop`,
    ``,
    `**⚙️ Settings:**`,
    `• /settings, /setflood, /setfloodaction`,
    `• /setwelcome, /setgoodbye`,
    ``
  ];
  
  if (isSudoUser) {
    helpText.push(...[
      ``,
      `**👑 Owner Panel:**`,
      `• /owner - Open owner panel`,
      `• /stats - Bot statistics`,
      `• /sudo - Manage sudo admins`,
      `• /broadcast - Send global message`,
      `• /globalban - Ban user from all groups`,
      `• /gclist - List all groups`,
      `• /leave - Leave a group`,
      `• /restart - Restart bot`
    ]);
  }
  
  helpText.push(``, `_RG: @SHAYAMxESCROW_`);
  await sendMessage(chatId, helpText.join("\n"), msgId, "Markdown");
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
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ You are not authorized to use this command.", msgId);
    return;
  }
  
  const totalUsers = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_users'`).get()?.value || 0;
  const totalGroups = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_groups'`).get()?.value || 0;
  const totalCommands = db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_commands'`).get()?.value || 0;
  const sudoCount = db.prepare(`SELECT COUNT(*) as count FROM sudo_users`).get().count;
  const globalBans = db.prepare(`SELECT COUNT(*) as count FROM global_bans`).get().count;
  
  const panel = [
    `👑 **OWNER CONTROL PANEL**`,
    ``,
    `📊 **Bot Statistics:**`,
    `• Users: ${totalUsers}`,
    `• Groups: ${totalGroups}`,
    `• Commands: ${totalCommands}`,
    `• Sudo Admins: ${sudoCount}`,
    `• Global Bans: ${globalBans}`,
    ``,
    `🛠️ **Available Commands:**`,
    `• /broadcast - Send message to all users`,
    `• /stats - View bot statistics`,
    `• /sudo - Manage sudo users`,
    `• /globalban - Global ban a user`,
    `• /globalunban - Remove global ban`,
    `• /leave - Leave a group`,
    `• /gclist - List all groups`,
    `• /getlink - Get group invite link`,
    `• /restart - Restart the bot`,
    ``,
    `📈 **Bot Status:** 🟢 Online`,
    `👨‍💻 **Developer:** @clerkMM, @auramanxhere`
  ].join("\n");
  
  await sendMessage(chatId, panel, msgId, "Markdown");
}

async function handleBroadcast(chatId, userId, message, msgId) {
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Owner only command.", msgId);
    return;
  }
  
  if (!message) {
    await sendMessage(chatId, "Usage: `/broadcast <message>`", msgId);
    return;
  }
  
  await sendMessage(chatId, "📢 Broadcasting message... This may take a while.", msgId);
  
  const chats = new Set();
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  groups.forEach(g => chats.add(g.chat_id));
  
  let success = 0;
  let failed = 0;
  
  for (const chat of chats) {
    try {
      await sendMessage(chat, message, null, "Markdown");
      success++;
      await new Promise(r => setTimeout(r, 50));
    } catch {
      failed++;
    }
  }
  
  await sendMessage(chatId, `✅ Broadcast complete!\nSuccess: ${success}\nFailed: ${failed}`, msgId);
}

async function handleStats(chatId, userId, msgId) {
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Admin only command.", msgId);
    return;
  }
  
  const stats = {
    totalUsers: db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_users'`).get()?.value || 0,
    totalGroups: db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_groups'`).get()?.value || 0,
    totalCommands: db.prepare(`SELECT value FROM bot_stats WHERE key = 'total_commands'`).get()?.value || 0,
    sudoCount: db.prepare(`SELECT COUNT(*) as count FROM sudo_users`).get().count,
    globalBans: db.prepare(`SELECT COUNT(*) as count FROM global_bans`).get().count,
    activeGroups: db.prepare(`SELECT COUNT(*) as count FROM group_settings`).get().count,
    filtersCount: db.prepare(`SELECT COUNT(*) as count FROM filters`).get().count,
    warningsCount: db.prepare(`SELECT COUNT(*) as count FROM user_warnings`).get().count
  };
  
  const statsMsg = [
    `📊 **SHAYAMxESCROW Bot Statistics**`,
    ``,
    `**Bot Info:**`,
    `• Uptime: ${Math.floor(process.uptime() / 60)} minutes`,
    `• Node Version: ${process.version}`,
    ``,
    `**Database Stats:**`,
    `• Total Users: ${stats.totalUsers}`,
    `• Total Groups: ${stats.totalGroups}`,
    `• Active Groups: ${stats.activeGroups}`,
    `• Commands Used: ${stats.totalCommands}`,
    `• Sudo Admins: ${stats.sudoCount}`,
    `• Global Bans: ${stats.globalBans}`,
    `• Active Filters: ${stats.filtersCount}`,
    `• Total Warnings: ${stats.warningsCount}`,
    ``,
    `**Memory Usage:**`,
    `• ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
    ``,
    `👨‍💻 **Developer:** @clerkMM, @auramanxhere`
  ].join("\n");
  
  await sendMessage(chatId, statsMsg, msgId, "Markdown");
}

async function handleSudo(chatId, userId, action, targetId, msgId) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, "❌ Only the bot owner can manage sudo users.", msgId);
    return;
  }
  
  if (!action || !targetId) {
    const sudoList = db.prepare(`SELECT user_id FROM sudo_users`).all();
    const sudoMentions = sudoList.map(s => `• \`${s.user_id}\``).join("\n");
    await sendMessage(chatId, `**Sudo Users:**\n${sudoMentions || "None"}\n\nUsage:\n• /sudo add <user_id>\n• /sudo remove <user_id>`, msgId, "Markdown");
    return;
  }
  
  const target = parseInt(targetId);
  
  if (action === 'add') {
    if (target === OWNER_ID) {
      await sendMessage(chatId, "❌ Owner is already sudo by default.", msgId);
      return;
    }
    db.prepare(`INSERT OR IGNORE INTO sudo_users (user_id) VALUES (?)`).run(target);
    await sendMessage(chatId, `✅ Added \`${target}\` as sudo admin.`, msgId, "Markdown");
  } else if (action === 'remove') {
    db.prepare(`DELETE FROM sudo_users WHERE user_id = ?`).run(target);
    await sendMessage(chatId, `✅ Removed \`${target}\` from sudo users.`, msgId, "Markdown");
  } else {
    await sendMessage(chatId, "Invalid action. Use `add` or `remove`.", msgId);
  }
}

async function handleGlobalBan(chatId, userId, targetId, reason, msgId) {
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only command.", msgId);
    return;
  }
  
  if (!targetId) {
    await sendMessage(chatId, "Usage: `/globalban <user_id> <reason>`", msgId);
    return;
  }
  
  const target = parseInt(targetId);
  
  db.prepare(`INSERT OR REPLACE INTO global_bans (user_id, reason, banned_by, banned_at) VALUES (?, ?, ?, ?)`).run(target, reason || "No reason", userId, Date.now());
  
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  let kickedCount = 0;
  
  for (const group of groups) {
    try {
      await kickUser(group.chat_id, target);
      kickedCount++;
      await new Promise(r => setTimeout(r, 100));
    } catch {}
  }
  
  await sendMessage(chatId, `✅ Globally banned \`${target}\`\nReason: ${reason || "No reason"}\nKicked from ${kickedCount} groups.`, msgId, "Markdown");
}

async function handleGlobalUnban(chatId, userId, targetId, msgId) {
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only command.", msgId);
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
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only command.", msgId);
    return;
  }
  
  const groups = db.prepare(`SELECT chat_id FROM group_settings`).all();
  if (groups.length === 0) {
    await sendMessage(chatId, "No groups found.", msgId);
    return;
  }
  
  let list = "**📋 Groups List:**\n\n";
  for (let i = 0; i < Math.min(groups.length, 20); i++) {
    try {
      const chat = await telegram("getChat", { chat_id: groups[i].chat_id });
      list += `${i+1}. ${chat.title} - \`${chat.id}\`\n`;
    } catch {
      list += `${i+1}. Unknown - \`${groups[i].chat_id}\`\n`;
    }
  }
  
  if (groups.length > 20) {
    list += `\n... and ${groups.length - 20} more groups.`;
  }
  
  await sendMessage(chatId, list, msgId, "Markdown");
}

async function handleGetLink(chatId, userId, targetChatId, msgId) {
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only command.", msgId);
    return;
  }
  
  const chat_id = targetChatId || chatId;
  try {
    const link = await telegram("exportChatInviteLink", { chat_id });
    await sendMessage(chatId, `🔗 Invite link: ${link}`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to get invite link. Make sure I'm admin.", msgId);
  }
}

async function handleLeave(chatId, userId, targetChatId, msgId) {
  if (userId !== OWNER_ID && !isSudo(userId)) {
    await sendMessage(chatId, "❌ Sudo only command.", msgId);
    return;
  }
  
  const leaveChatId = targetChatId || chatId;
  await sendMessage(chatId, `👋 Leaving chat ${leaveChatId}...`, msgId);
  await leaveChat(leaveChatId);
  db.prepare(`DELETE FROM group_settings WHERE chat_id = ?`).run(leaveChatId);
}

async function handleRestart(chatId, userId, msgId) {
  if (userId !== OWNER_ID) {
    await sendMessage(chatId, "❌ Owner only command.", msgId);
    return;
  }
  
  await sendMessage(chatId, "🔄 Restarting bot...", msgId);
  process.exit(0);
}

// ============ GROUP MANAGEMENT COMMANDS ============

async function handleAdminList(chatId, msgId) {
  try {
    const admins = await telegram("getChatAdministrators", { chat_id: chatId });
    const adminList = admins.map(a => `👑 ${a.user.first_name} (${a.user.id})`).join("\n");
    await sendMessage(chatId, `**Admins in this group:**\n\n${adminList}`, msgId, "Markdown");
  } catch {
    await sendMessage(chatId, "Failed to get admin list. Make sure I'm admin.", msgId);
  }
}

async function handleMentionAdmins(chatId, msgId) {
  try {
    const admins = await telegram("getChatAdministrators", { chat_id: chatId });
    const mentions = admins.map(a => `@${a.user.username || a.user.first_name}`).join(" ");
    await sendMessage(chatId, `📢 Calling admins: ${mentions}`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to mention admins.", msgId);
  }
}

async function handleBan(chatId, userId, targetId, reason, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ You need to be an admin to use this command.", msgId);
    return;
  }
  try {
    await kickUser(chatId, targetId);
    await sendMessage(chatId, `🔨 User banned. Reason: ${reason || "No reason provided"}`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to ban user. Check my permissions.", msgId);
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
    await sendMessage(chatId, `👢 User kicked.`, msgId);
  } catch {
    await sendMessage(chatId, "Failed to kick user.", msgId);
  }
}

async function handleMute(chatId, userId, targetId, duration = 3600, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  try {
    const until = Math.floor(Date.now() / 1000) + duration;
    await restrictUser(chatId, targetId, until, false);
    db.prepare(`INSERT OR REPLACE INTO muted_users (user_id, chat_id, until) VALUES (?, ?, ?)`).run(targetId, chatId, until);
    await sendMessage(chatId, `🔇 User muted for ${duration / 60} minutes.`, msgId);
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
    db.prepare(`DELETE FROM muted_users WHERE user_id = ? AND chat_id = ?`).run(targetId, chatId);
    await sendMessage(chatId, `🔊 User unmuted.`, msgId);
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
  
  await sendMessage(chatId, `⚠️ User warned! (${newCount}/3 warnings)\nReason: ${reason || "No reason"}`, msgId);
  
  if (newCount >= 3) {
    await kickUser(chatId, targetId);
    db.prepare(`DELETE FROM user_warnings WHERE user_id = ? AND chat_id = ?`).run(targetId, chatId);
    await sendMessage(chatId, `🔨 User has been banned for exceeding 3 warnings.`, msgId);
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
  await sendMessage(chatId, `✅ User warnings reset.`, msgId);
}

async function handlePurge(chatId, userId, count, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  if (!count || count < 1 || count > 100) {
    await sendMessage(chatId, "Please provide a number between 1-100. Example: `/purge 50`", msgId);
    return;
  }
  await sendMessage(chatId, `🗑️ Deleting ${count} messages...`, msgId);
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
    await sendMessage(chatId, "No filters set in this group.", msgId);
    return;
  }
  const list = filters.map(f => `• ${f.keyword}`).join("\n");
  await sendMessage(chatId, `**Active filters:**\n${list}`, msgId);
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
    await sendMessage(chatId, `Filter "${keyword}" not found.`, msgId);
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
  
  const settingsText = [
    `⚙️ **Group Settings**`,
    ``,
    `🛡️ **Anti-Flood:** ${flood} msgs/5sec (0=disabled)`,
    `🎯 **Flood Action:** ${action}`,
    `👋 **Welcome:** ${settings?.welcome_msg ? '✅ Set' : '❌ Not set'}`,
    `👋 **Goodbye:** ${settings?.goodbye_msg ? '✅ Set' : '❌ Not set'}`,
    ``,
    `**Commands to modify:**`,
    `• /setflood <count>`,
    `• /setfloodaction <mute/kick/ban>`,
    `• /setwelcome <text>`,
    `• /setgoodbye <text>`
  ].join("\n");
  
  await sendMessage(chatId, settingsText, msgId, "Markdown");
}

async function handleSetFlood(chatId, userId, limit, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  const floodLimit = parseInt(limit);
  if (isNaN(floodLimit) || floodLimit < 0) {
    await sendMessage(chatId, "Please provide a valid number (0 to disable).", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, anti_flood) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET anti_flood = excluded.anti_flood`).run(chatId, floodLimit);
  await sendMessage(chatId, `✅ Anti-flood set to ${floodLimit} messages per 5 seconds.`, msgId);
}

async function handleSetFloodAction(chatId, userId, action, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  if (!['mute', 'kick', 'ban'].includes(action)) {
    await sendMessage(chatId, "Invalid action. Use: `mute`, `kick`, or `ban`", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, flood_action) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET flood_action = excluded.flood_action`).run(chatId, action);
  await sendMessage(chatId, `✅ Flood action set to ${action}.`, msgId);
}

async function handleSetWelcome(chatId, userId, text, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, welcome_msg) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET welcome_msg = excluded.welcome_msg`).run(chatId, text);
  await sendMessage(chatId, `✅ Welcome message set.\nUse @USER for user mention.`, msgId);
}

async function handleSetGoodbye(chatId, userId, text, msgId) {
  if (!await isAdmin(chatId, userId)) {
    await sendMessage(chatId, "❌ Admin only.", msgId);
    return;
  }
  db.prepare(`INSERT OR REPLACE INTO group_settings (chat_id, goodbye_msg) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET goodbye_msg = excluded.goodbye_msg`).run(chatId, text);
  await sendMessage(chatId, `✅ Goodbye message set.`, msgId);
}

async function handleId(chatId, userId, msgId) {
  await sendMessage(chatId, `🆔 Your ID: \`${userId}\`\n📢 Chat ID: \`${chatId}\``, msgId, "Markdown");
}

// ============ FILTER CHECKER ============
async function checkFilters(chatId, text, reply
