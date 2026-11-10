/**
 * TYLA 💋 Moderator Bot
 * Full clean version - no broken templates, web pairing, Render ready
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const express = require('express');
const config = require('./config');
const menu = require('./lib/menu');
const store = require('./lib/store');
const {
  replyWithPfp,
  replyText,
  isOwner,
  getNumber,
  getGroupMeta,
  isGroupAdmin,
  isBotAdmin,
  extractTarget,
  hasLink
} = require('./lib/func');

fs.ensureDirSync(config.authDir || './auth_info');
fs.ensureDirSync('./data');

let sock = null;
let isConnected = false;
const PORT = process.env.PORT || 3000;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir || './auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['TYLA Moderator', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      isConnected = true;
      console.log('✅ ' + config.botName + ' connected');
      console.log('   Prefix: ' + config.prefix);
    }

    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...');
        setTimeout(startBot, 3000);
      } else {
        console.log('Logged out. Delete auth_info and restart.');
      }
    }
  });

  // Welcome / Goodbye / Blacklist
  sock.ev.on('group-participants.update', async (update) => {
    const { id: gid, participants, action } = update;
    const settings = store.getSettings(gid);

    for (const user of participants) {
      const num = getNumber(user);

      if (store.getBlacklist().includes(num)) {
        try {
          await sock.groupParticipantsUpdate(gid, [user], 'remove');
        } catch (e) {}
        continue;
      }

      if (action === 'add') {
        if (settings.antifake && (num.length < 10 || num.startsWith('0'))) {
          try {
            await sock.groupParticipantsUpdate(gid, [user], 'remove');
          } catch (e) {}
          continue;
        }
        if (settings.welcome) {
          let text = store.getWelcome(gid).replace(/@user/gi, '@' + num);
          await sock.sendMessage(gid, { text: text, mentions: [user] });
        }
      }

      if (action === 'remove' && settings.goodbye) {
        let text = store.getGoodbye(gid).replace(/@user/gi, '@' + num);
        await sock.sendMessage(gid, { text: text, mentions: [user] });
      }
    }
  });

  // Anticall
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      if (call.status === 'offer') {
        try {
          await sock.rejectCall(call.id, call.from);
        } catch (e) {}
      }
    }
  });

  // Messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const from = msg.key.participant || msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const num = getNumber(from);

    if (store.getBlacklist().includes(num)) return;

    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      '';

    // Anti features
    if (isGroup) {
      const settings = store.getSettings(jid);
      const isAdmin = await isGroupAdmin(sock, jid, from);
      const botAdmin = await isBotAdmin(sock, jid);

      if (settings.antilink && hasLink(body) && !isAdmin && botAdmin) {
        try {
          await sock.sendMessage(jid, { delete: msg.key });
          if (settings.antilinkaction === 'warn') {
            const count = store.addWarn(jid, from, 'Antilink');
            await replyText(sock, jid, '⚠️ Link detected. Warning ' + count + '/' + settings.warnLimit, msg);
            if (count >= settings.warnLimit) {
              await sock.groupParticipantsUpdate(jid, [from], 'remove');
              store.resetWarns(jid, from);
            }
          } else if (settings.antilinkaction === 'kick') {
            await sock.groupParticipantsUpdate(jid, [from], 'remove');
          }
        } catch (e) {}
        return;
      }

      if (settings.antibadword && !isAdmin) {
        const bad = store.getBadwords();
        if (bad.some(w => body.toLowerCase().includes(w))) {
          try {
            await sock.sendMessage(jid, { delete: msg.key });
          } catch (e) {}
          return;
        }
      }

      if (settings.antisticker && msg.message.stickerMessage && !isAdmin && botAdmin) {
        try {
          await sock.sendMessage(jid, { delete: msg.key });
        } catch (e) {}
        return;
      }

      if (!isAdmin && botAdmin) {
        if (settings.antivideo && msg.message.videoMessage) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          return;
        }
        if (settings.antiaudio && msg.message.audioMessage) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          return;
        }
        if (settings.antidocument && msg.message.documentMessage) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          return;
        }
        if (settings.antimedia && (msg.message.imageMessage || msg.message.videoMessage || msg.message.stickerMessage)) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          return;
        }
      }
    }

    if (!body.startsWith(config.prefix)) return;

    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const command = (args.shift() || '').toLowerCase();
    const text = args.join(' ');

    if (isGroup) {
      const settings = store.getSettings(jid);
      if (settings.adminonly && !(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return;
    }

    try {
      switch (command) {

        case 'menu':
        case 'help':
        case 'list':
          await replyWithPfp(sock, jid, menu(config.prefix), msg);
          break;

        case 'ping':
          await replyWithPfp(sock, jid, '🏓 Pong!\n' + config.botName + ' is online.', msg);
          break;

        case 'owner': {
          const ownersList = (config.owners || []).map(o => '+' + o).join('\n') || 'Not set';
          await replyWithPfp(sock, jid, '👑 *Owners*\n' + ownersList, msg);
          break;
        }

        case 'bot':
        case 'info':
          await replyWithPfp(sock, jid, '╭━━━━━━━━━━━┳━━━━━━━━━━━╮\n┃  TYLA 💋   ┃  ONLINE   ┃\n╰━━━━━━━━━━━┻━━━━━━━━━━━╯\nPrefix: ' + config.prefix, msg);
          break;

        // Protection toggles
        case 'antilink':
        case 'antibot':
        case 'antispam':
        case 'antifake':
        case 'antiviewonce':
        case 'antisticker':
        case 'antiforeign':
        case 'antidelete':
        case 'antitag':
        case 'antidemote':
        case 'antipromote':
        case 'anticall':
        case 'antimedia':
        case 'antilocation':
        case 'anticontact':
        case 'antipoll':
        case 'antishare':
        case 'antivideo':
        case 'antiaudio':
        case 'antidocument':
        case 'antigcstatus':
        case 'antigmention':
        case 'antichannel':
        case 'antistatusmention':
        case 'antilinkstatus':
        case 'antibadword':
        case 'welcome':
        case 'goodbye':
        case 'adminonly':
        case 'lock':
        case 'unlock': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);

          const key = (command === 'lock' || command === 'unlock') ? 'locked' : command;
          const settings = store.getSettings(jid);
          let newVal = command === 'lock' ? true : command === 'unlock' ? false : !settings[key];

          store.setSetting(jid, key, newVal);
          await replyWithPfp(sock, jid, '✅ *' + command.toUpperCase() + '* is now *' + (newVal ? 'ON' : 'OFF') + '*', msg);
          break;
        }

        case 'antilinkaction': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const action = (args[0] || '').toLowerCase();
          if (!['delete', 'warn', 'kick'].includes(action)) {
            return replyText(sock, jid, 'Usage: .antilinkaction delete|warn|kick', msg);
          }
          store.setSetting(jid, 'antilinkaction', action);
          await replyWithPfp(sock, jid, '✅ Antilink action set to *' + action + '*', msg);
          break;
        }

        case 'addbadword': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          if (!args[0]) return replyText(sock, jid, 'Usage: .addbadword word', msg);
          store.addBadword(args[0]);
          await replyWithPfp(sock, jid, '✅ Added badword: *' + args[0] + '*', msg);
          break;
        }

        case 'delbadword': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          if (!args[0]) return replyText(sock, jid, 'Usage: .delbadword word', msg);
          store.delBadword(args[0]);
          await replyWithPfp(sock, jid, '✅ Removed badword: *' + args[0] + '*', msg);
          break;
        }

        case 'badwordlist': {
          const list = store.getBadwords();
          await replyWithPfp(sock, jid, '📝 *Badwords*\n' + (list.length ? list.map(w => '• ' + w).join('\n') : 'Empty'), msg);
          break;
        }

        // Warn system
        case 'warn': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          const reason = text.replace(getNumber(target), '').trim() || 'No reason';
          const count = store.addWarn(jid, target, reason);
          const limit = store.getSettings(jid).warnLimit;
          await replyWithPfp(sock, jid, '⚠️ Warned @' + getNumber(target) + '\nReason: ' + reason + '\nWarnings: ' + count + '/' + limit, msg);
          if (count >= limit) {
            await sock.groupParticipantsUpdate(jid, [target], 'remove');
            store.resetWarns(jid, target);
            await replyText(sock, jid, '🔨 User removed (warn limit reached)');
          }
          break;
        }

        case 'unwarn': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          const left = store.removeWarn(jid, target, 1);
          await replyWithPfp(sock, jid, '✅ Removed 1 warn from @' + getNumber(target) + '\nRemaining: ' + left, msg);
          break;
        }

        case 'warnings':
        case 'checkwarn': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const target = extractTarget(msg, args) || from;
          const warns = store.getWarns(jid)[target] || [];
          const list = warns.map((w, i) => (i + 1) + '. ' + w.reason + ' (' + new Date(w.time).toLocaleString() + ')').join('\n') || 'No warnings';
          await replyWithPfp(sock, jid, '⚠️ Warnings for @' + getNumber(target) + '\n\n' + list, msg);
          break;
        }

        case 'resetwarn':
        case 'clearwarns': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          store.resetWarns(jid, target);
          await replyWithPfp(sock, jid, target ? '✅ Warns cleared for @' + getNumber(target) : '✅ All warns cleared', msg);
          break;
        }

        case 'warnlist':
        case 'topwarned': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const warns = store.getWarns(jid);
          const sorted = Object.entries(warns)
            .map(([u, w]) => ({ u: u, c: w.length }))
            .sort((a, b) => b.c - a.c)
            .slice(0, 15);
          const txt = sorted.map((x, i) => (i + 1) + '. @' + getNumber(x.u) + ' → ' + x.c + ' warns').join('\n') || 'No warns yet';
          await replyWithPfp(sock, jid, '📊 *Top Warned*\n\n' + txt, msg);
          break;
        }

        case 'setwarnlimit': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const limit = parseInt(args[0]);
          if (!limit || limit < 1) return replyText(sock, jid, 'Usage: .setwarnlimit 3', msg);
          store.setSetting(jid, 'warnLimit', limit);
          await replyWithPfp(sock, jid, '✅ Warn limit set to *' + limit + '*', msg);
          break;
        }

        case 'warnmode': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const mode = (args[0] || '').toLowerCase();
          if (!['kick', 'ban', 'mute'].includes(mode)) return replyText(sock, jid, 'Usage: .warnmode kick|ban|mute', msg);
          store.setSetting(jid, 'warnMode', mode);
          await replyWithPfp(sock, jid, '✅ Warn mode set to *' + mode + '*', msg);
          break;
        }

        case 'warncount': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const target = extractTarget(msg, args) || from;
          const count = store.getWarnCount(jid, target);
          await replyWithPfp(sock, jid, '⚠️ @' + getNumber(target) + ' has *' + count + '* warning(s)', msg);
          break;
        }

        // Punish
        case 'kick':
        case 'remove': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'remove');
          await replyWithPfp(sock, jid, '🔨 Kicked @' + getNumber(target), msg);
          break;
        }

        case 'ban': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          store.addBlacklist(getNumber(target));
          await sock.groupParticipantsUpdate(jid, [target], 'remove');
          await replyWithPfp(sock, jid, '🚫 Banned @' + getNumber(target), msg);
          break;
        }

        case 'unban': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number or tag.', msg);
          store.removeBlacklist(getNumber(target));
          await replyWithPfp(sock, jid, '✅ Unbanned @' + getNumber(target), msg);
          break;
        }

        case 'mute':
        case 'groupmute': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'announcement');
          await replyWithPfp(sock, jid, '🔇 Group muted', msg);
          break;
        }

        case 'unmute':
        case 'groupunmute': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await replyWithPfp(sock, jid, '🔊 Group unmuted', msg);
          break;
        }

        case 'add': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'add');
          await replyWithPfp(sock, jid, '✅ Added @' + getNumber(target), msg);
          break;
        }

        case 'promote': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag or reply.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'promote');
          await replyWithPfp(sock, jid, '⬆️ Promoted @' + getNumber(target), msg);
          break;
        }

        case 'demote': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag or reply.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'demote');
          await replyWithPfp(sock, jid, '⬇️ Demoted @' + getNumber(target), msg);
          break;
        }

        case 'tagall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const mentions = meta.participants.map(p => p.id);
          await sock.sendMessage(jid, {
            text: (text || '📢 Tag All') + '\n\n' + mentions.map(m => '@' + getNumber(m)).join(' '),
            mentions: mentions
          }, { quoted: msg });
          break;
        }

        case 'hidetag': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const mentions = meta.participants.map(p => p.id);
          await sock.sendMessage(jid, { text: text || '‎', mentions: mentions }, { quoted: msg });
          break;
        }

        case 'groupinfo': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const s = store.getSettings(jid);
          await replyWithPfp(sock, jid, '📋 *Group Info*\nName: ' + meta.subject + '\nMembers: ' + meta.participants.length + '\nAntilink: ' + (s.antilink ? 'ON' : 'OFF'), msg);
          break;
        }

        case 'groupname': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .groupname New Name', msg);
          await sock.groupUpdateSubject(jid, text);
          await replyWithPfp(sock, jid, '✅ Group name changed', msg);
          break;
        }

        case 'groupdesc': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .groupdesc text', msg);
          await sock.groupUpdateDescription(jid, text);
          await replyWithPfp(sock, jid, '✅ Description updated', msg);
          break;
        }

        case 'grouplink':
        case 'invite': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const code = await sock.groupInviteCode(jid);
          await replyWithPfp(sock, jid, '🔗 https://chat.whatsapp.com/' + code, msg);
          break;
        }

        case 'revoke': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupRevokeInvite(jid);
          await replyWithPfp(sock, jid, '✅ Link revoked', msg);
          break;
        }

        case 'closegroup': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'announcement');
          await replyWithPfp(sock, jid, '🔒 Group closed', msg);
          break;
        }

        case 'opengroup': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await replyWithPfp(sock, jid, '🔓 Group opened', msg);
          break;
        }

        case 'setwelcome': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .setwelcome Welcome @user', msg);
          store.setWelcome(jid, text);
          await replyWithPfp(sock, jid, '✅ Welcome set', msg);
          break;
        }

        case 'setgoodbye': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .setgoodbye Goodbye @user', msg);
          store.setGoodbye(jid, text);
          await replyWithPfp(sock, jid, '✅ Goodbye set', msg);
          break;
        }

        case 'adminlist': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const admins = meta.participants.filter(p => p.admin);
          const txt = admins.map(a => '• @' + getNumber(a.id)).join('\n');
          await replyWithPfp(sock, jid, '👑 *Admins*\n\n' + txt, msg);
          break;
        }

        case 'botadmin': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const isAdm = await isBotAdmin(sock, jid);
          await replyWithPfp(sock, jid, isAdm ? '✅ Bot is admin' : '❌ Bot is not admin', msg);
          break;
        }

        case 'rules':
        case 'listrules': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          await replyWithPfp(sock, jid, '📜 *Rules*\n\n' + store.getRules(jid), msg);
          break;
        }

        case 'setrules': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .setrules Your rules', msg);
          store.setRules(jid, text);
          await replyWithPfp(sock, jid, '✅ Rules updated', msg);
          break;
        }

        case 'delrules': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          store.delRules(jid);
          await replyWithPfp(sock, jid, '✅ Rules deleted', msg);
          break;
        }

        case 'blacklist': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) {
            const list = store.getBlacklist();
            return replyWithPfp(sock, jid, '🚫 *Blacklist*\n' + (list.length ? list.map(n => '• ' + n).join('\n') : 'Empty'), msg);
          }
          store.addBlacklist(getNumber(target));
          if (isGroup) await sock.groupParticipantsUpdate(jid, [target], 'remove').catch(() => {});
          await replyWithPfp(sock, jid, '🚫 Blacklisted @' + getNumber(target), msg);
          break;
        }

        case 'unblacklist': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number.', msg);
          store.removeBlacklist(getNumber(target));
          await replyWithPfp(sock, jid, '✅ Removed from blacklist', msg);
          break;
        }

        case 'memberlist': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const list = meta.participants.map((p, i) => (i + 1) + '. @' + getNumber(p.id) + (p.admin ? ' 👑' : '')).join('\n');
          await replyWithPfp(sock, jid, '👥 *Members* (' + meta.participants.length + ')\n\n' + list, msg);
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('Command error:', command, err.message);
    }
  });

  return sock;
          }

// ==================== WEB SERVER ====================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/pair', async (req, res) => {
  try {
    if (!sock) {
      return res.status(503).json({ error: 'Bot still starting. Wait 10 seconds and try again.' });
    }

    if (sock.authState && sock.authState.creds && sock.authState.creds.registered) {
      return res.status(400).json({
        error: 'Already linked. Delete auth_info folder and redeploy to pair again.'
      });
    }

    let phone = (req.body.phone || '').toString().replace(/[^0-9]/g, '');
    if (phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ error: 'Invalid number. Use country code + number, digits only.' });
    }

    const code = await sock.requestPairingCode(phone);
    console.log('📱 NEW PAIRING CODE for +' + phone + ' → ' + code);

    res.json({
      success: true,
      code: code,
      phone: phone,
      message: 'Enter this code RIGHT NOW on your phone'
    });
  } catch (err) {
    console.error('Pair error:', err.message);
    res.status(500).json({
      error: err.message || 'Failed to get code. Delete auth_info and try again.'
    });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: isConnected,
    registered: !!(sock && sock.authState && sock.authState.creds && sock.authState.creds.registered),
    botName: config.botName || 'TYLA'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Listening on port ' + PORT);
  console.log('Web UI ready');
});

console.log(`
╭━━━━━━━━━━━┳━━━━━━━━━━━╮
┃  TYLA 💋   ┃  STARTING ┃
╰━━━━━━━━━━━┻━━━━━━━━━━━╯
`);

startBot().catch(err => {
  console.error('Fatal:', err);
});
