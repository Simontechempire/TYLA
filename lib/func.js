const axios = require('axios');
const config = require('../config');
const store = require('./store');

async function getBotPfpBuffer() {
  try {
    const res = await axios.get(config.botPfp, {
      responseType: 'arraybuffer',
      timeout: 15000
    });
    return Buffer.from(res.data);
  } catch (e) {
    console.error('Failed to fetch bot PFP:', e.message);
    return null;
  }
}

async function replyWithPfp(sock, jid, text, quoted = null) {
  const buffer = await getBotPfpBuffer();

  const contextInfo = {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: config.newsletterJid
      ? {
          newsletterJid: config.newsletterJid,
          newsletterName: config.botName,
          serverMessageId: -1
        }
      : undefined,
    externalAdReply: {
      title: config.botName,
      body: 'Moderator • No spam. No link. No nonsense.',
      thumbnailUrl: config.botPfp,
      sourceUrl: config.botPfp,
      mediaType: 1,
      renderLargerThumbnail: false
    }
  };

  if (buffer) {
    await sock.sendMessage(jid, {
      image: buffer,
      caption: text,
      mimetype: 'image/jpeg',
      contextInfo
    }, { quoted });
  } else {
    await sock.sendMessage(jid, { text, contextInfo }, { quoted });
  }
}

async function replyText(sock, jid, text, quoted = null) {
  const contextInfo = {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: config.newsletterJid
      ? {
          newsletterJid: config.newsletterJid,
          newsletterName: config.botName,
          serverMessageId: -1
        }
      : undefined
  };
  await sock.sendMessage(jid, { text, contextInfo }, { quoted });
}

function isOwner(sender) {
  const num = sender.replace(/[^0-9]/g, '');
  return config.owners.some(o => num.endsWith(o) || o.endsWith(num));
}

function getNumber(jid) {
  return (jid || '').split('@')[0].replace(/[^0-9]/g, '');
}

async function getGroupMeta(sock, gid) {
  try {
    return await sock.groupMetadata(gid);
  } catch {
    return null;
  }
}

async function isGroupAdmin(sock, gid, user) {
  const meta = await getGroupMeta(sock, gid);
  if (!meta) return false;
  const p = meta.participants.find(x => x.id === user || x.id.split('@')[0] === user.split('@')[0]);
  return p ? (p.admin === 'admin' || p.admin === 'superadmin') : false;
}

async function isBotAdmin(sock, gid) {
  const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  return await isGroupAdmin(sock, gid, botId);
}

function getMentioned(msg) {
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return mentioned;
}

function getQuotedUser(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (ctx?.participant) return ctx.participant;
  if (ctx?.quotedMessage) return msg.key.participant || msg.key.remoteJid;
  return null;
}

function extractTarget(msg, args) {
  // priority: mention > reply > number argument
  const mentioned = getMentioned(msg);
  if (mentioned.length) return mentioned[0];

  const quoted = getQuotedUser(msg);
  if (quoted) return quoted;

  if (args[0]) {
    let num = args[0].replace(/[^0-9]/g, '');
    if (num.length > 8) return num + '@s.whatsapp.net';
  }
  return null;
}

function hasLink(text) {
  return /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-z0-9-]+\.(com|net|org|xyz|me|io|co|app|link|gg|tk|ml|ga|cf|gq)\b)/i.test(text);
}

module.exports = {
  getBotPfpBuffer,
  replyWithPfp,
  replyText,
  isOwner,
  getNumber,
  getGroupMeta,
  isGroupAdmin,
  isBotAdmin,
  getMentioned,
  getQuotedUser,
  extractTarget,
  hasLink
};
