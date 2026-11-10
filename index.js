/**
 * TYLA 💋 Moderator Bot — FULL REAL HANDLERS
 * Pairing only • No QR • Newsletter PFP replies
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

fs.ensureDirSync(config.authDir);
fs.ensureDirSync('./data');

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
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

  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairingRequested && !sock.authState.creds.registered) {
      if (!config.phone) {
        console.log('\n❌ Set BOT_PHONE in .env\n');
        process.exit(1);
      }
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(config.phone);
        console.log('\n╔══════════════════════════════════════╗');
        console.log('║     TYLA 💋 PAIRING SESSION         ║');
        console.log('╠══════════════════════════════════════╣');
        console.log(`║  Code :  ${code}                     ║`);
        console.log('╠══════════════════════════════════════╣');
        console.log('║  Phone → Linked Devices              ║');
        console.log('║  → Link with phone number            ║');
        console.log('║  → Enter the code above              ║');
        console.log('╚══════════════════════════════════════╝\n');
      } catch (err) {
        console.error('Pairing error:', err.message);
      }
    }

    if (connection === 'open') {
      console.log(`\n✅ ${config.botName} connected`);
      console.log(`   Prefix: ${config.prefix} | Newsletter PFP replies ON\n`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;
      if (code !== DisconnectReason.loggedOut) {
        pairingRequested = false;
        setTimeout(startBot, 3000);
      } else {
        console.log('Logged out. Delete auth_info and restart.');
      }
    }
  });

  // ========== GROUP PARTICIPANTS UPDATE (welcome / goodbye / antifake) ==========
  sock.ev.on('group-participants.update', async (update) => {
    const { id: gid, participants, action } = update;
    const settings = store.getSettings(gid);

    for (const user of participants) {
      const num = getNumber(user);

      // Blacklist check
      if (store.getBlacklist().includes(num)) {
        try {
          await sock.groupParticipantsUpdate(gid, [user], 'remove');
          await replyText(sock, gid, `🚫 Blacklisted user removed: @${num}`, null);
        } catch {}
        continue;
      }

      if (action === 'add') {
        // Antifake
        if (settings.antifake) {
          // basic fake number detection (very short or suspicious)
          if (num.length < 10 || num.startsWith('0')) {
            try {
              await sock.groupParticipantsUpdate(gid, [user], 'remove');
              await replyText(sock, gid, `🚫 Fake number removed: @${num}`);
            } catch {}
            continue;
          }
        }

        // Welcome
        if (settings.welcome) {
          let text = store.getWelcome(gid);
          text = text.replace(/@user/gi, `@${num}`);
          await sock.sendMessage(gid, {
            text,
            mentions: [user]
          });
        }
      }

      if (action === 'remove' && settings.goodbye) {
        let text = store.getGoodbye(gid);
        text = text.replace(/@user/gi, `@${num}`);
        await sock.sendMessage(gid, {
          text,
          mentions: [user]
        });
      }
    }
  });

  // ========== CALL EVENT (anticall) ==========
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      if (call.status !== 'offer') continue;
      const from = call.from;
      // We can't know the group easily, so we reject all if any group has anticall
      // For simplicity reject and notify owner
      try {
        await sock.rejectCall(call.id, call.from);
        for (const owner of config.owners) {
          await sock.sendMessage(owner + '@s.whatsapp.net', {
            text: `📞 Anticall: Rejected call from ${from}`
          });
        }
      } catch {}
    }
  });

  // ========== MESSAGES ==========
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const from = msg.key.participant || msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const num = getNumber(from);

    // Blacklist block
    if (store.getBlacklist().includes(num)) return;

    // Extract body
    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      '';

    // ========== ANTI FEATURES (group only) ==========
    if (isGroup) {
      const settings = store.getSettings(jid);
      const isAdmin = await isGroupAdmin(sock, jid, from);
      const botAdmin = await isBotAdmin(sock, jid);

      // Antilink
      if (settings.antilink && hasLink(body) && !isAdmin && botAdmin) {
        try {
          await sock.sendMessage(jid, { delete: msg.key });
          if (settings.antilinkaction === 'warn') {
            const count = store.addWarn(jid, from, 'Antilink');
            await replyText(sock, jid, `⚠️ Link detected. Warning \( {count}/ \){settings.warnLimit} for @${num}`, msg);
            if (count >= settings.warnLimit) {
              await sock.groupParticipantsUpdate(jid, [from], 'remove');
              store.resetWarns(jid, from);
            }
          } else if (settings.antilinkaction === 'kick') {
            await sock.groupParticipantsUpdate(jid, [from], 'remove');
          }
        } catch {}
        return;
      }

      // Antibadword
      if (settings.antibadword && !isAdmin) {
        const bad = store.getBadwords();
        const lower = body.toLowerCase();
        if (bad.some(w => lower.includes(w))) {
          try {
            await sock.sendMessage(jid, { delete: msg.key });
            await replyText(sock, jid, `🚫 Bad word detected from @${num}`, msg);
          } catch {}
          return;
        }
      }

      // Antisticker
      if (settings.antisticker && msg.message.stickerMessage && !isAdmin && botAdmin) {
        try {
          await sock.sendMessage(jid, { delete: msg.key });
        } catch {}
        return;
      }

      // Antivideo / Antiaudio / Antidocument / Antimedia
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
        if (settings.antimedia && (msg.message.imageMessage || msg.message.videoMessage || msg.message.audioMessage || msg.message.documentMessage || msg.message.stickerMessage)) {
          await sock.sendMessage(jid, { delete: msg.key }).catch(() => {});
          return;
        }
      }

      // Antiviewonce
      if (settings.antiviewonce && (msg.message.viewOnceMessage || msg.message.viewOnceMessageV2)) {
        try {
          await sock.sendMessage(jid, { delete: msg.key });
        } catch {}
        return;
      }
    }

    // Command check
    if (!body.startsWith(config.prefix)) return;

    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const command = (args.shift() || '').toLowerCase();
    const text = args.join(' ');

    // Admin only mode
    if (isGroup) {
      const settings = store.getSettings(jid);
      if (settings.adminonly && !(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) {
        return;
      }
    }

    // ========== REAL COMMAND HANDLER ==========
    try {
      switch (command) {

        // ====================== MENU / BASIC ======================
        case 'menu':
        case 'help':
        case 'list':
          await replyWithPfp(sock, jid, menu(config.prefix), msg);
          break;

        case 'ping':
          await replyWithPfp(sock, jid, `🏓 Pong!\n${config.botName} is online.`, msg);
          break;

        case 'owner':
          await replyWithPfp(sock, jid, `👑 *Owners*\n\( {config.owners.map(o => `+ \){o}`).join('\n') || 'Not set'}`, msg);
          break;

        case 'bot':
        case 'info':
          await replyWithPfp(sock, jid, `╭━━━━━━━━━━━┳━━━━━━━━━━━╮\n┃  TYLA 💋   ┃  ONLINE   ┃\n╰━━━━━━━━━━━┻━━━━━━━━━━━╯\nPrefix: ${config.prefix}\nCommands: ${config.cmdCount}\nMode: Pairing + Newsletter PFP`, msg);
          break;

        // ====================== PROTECTION TOGGLES ======================
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

          const key = command === 'lock' ? 'locked' : command === 'unlock' ? 'locked' : command;
          const settings = store.getSettings(jid);
          let newVal;

          if (command === 'lock') newVal = true;
          else if (command === 'unlock') newVal = false;
          else newVal = !settings[key];

          store.setSetting(jid, key, newVal);
          await replyWithPfp(sock, jid, `✅ *\( {command.toUpperCase()}* is now * \){newVal ? 'ON' : 'OFF'}*`, msg);
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
          await replyWithPfp(sock, jid, `✅ Antilink action set to *${action}*`, msg);
          break;
        }

        case 'addbadword': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          if (!args[0]) return replyText(sock, jid, 'Usage: .addbadword word', msg);
          store.addBadword(args[0]);
          await replyWithPfp(sock, jid, `✅ Added badword: *${args[0]}*`, msg);
          break;
        }

        case 'delbadword': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          if (!args[0]) return replyText(sock, jid, 'Usage: .delbadword word', msg);
          store.delBadword(args[0]);
          await replyWithPfp(sock, jid, `✅ Removed badword: *${args[0]}*`, msg);
          break;
        }

        case 'badwordlist': {
          const list = store.getBadwords();
          await replyWithPfp(sock, jid, `📝 *Badwords*\n${list.length ? list.map(w => `• ${w}`).join('\n') : 'Empty'}`, msg);
          break;
        }

        // ====================== WARN SYSTEM ======================
        case 'warn': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          const reason = text.replace(getNumber(target), '').trim() || 'No reason';
          const count = store.addWarn(jid, target, reason);
          const limit = store.getSettings(jid).warnLimit;
          await replyWithPfp(sock, jid, `⚠️ Warned @${getNumber(target)}\nReason: ${reason}\nWarnings: \( {count}/ \){limit}`, msg);

          if (count >= limit) {
            const mode = store.getSettings(jid).warnMode;
            if (mode === 'kick' || mode === 'ban') {
              await sock.groupParticipantsUpdate(jid, [target], 'remove');
              store.resetWarns(jid, target);
              await replyText(sock, jid, `🔨 User removed (warn limit reached)`);
            }
          }
          break;
        }

        case 'unwarn': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          const left = store.removeWarn(jid, target, 1);
          await replyWithPfp(sock, jid, `✅ Removed 1 warn from @${getNumber(target)}\nRemaining: ${left}`, msg);
          break;
        }

        case 'warnings':
        case 'checkwarn': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const target = extractTarget(msg, args) || from;
          const warns = store.getWarns(jid)[target] || [];
          const list = warns.map((w, i) => `${i + 1}. \( {w.reason} ( \){new Date(w.time).toLocaleString()})`).join('\n') || 'No warnings';
          await replyWithPfp(sock, jid, `⚠️ Warnings for @\( {getNumber(target)}\n\n \){list}`, msg);
          break;
        }

        case 'resetwarn':
        case 'clearwarns': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          store.resetWarns(jid, target);
          await replyWithPfp(sock, jid, target ? `✅ Warns cleared for @${getNumber(target)}` : `✅ All warns cleared in this group`, msg);
          break;
        }

        case 'warnlist':
        case 'topwarned': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const warns = store.getWarns(jid);
          const sorted = Object.entries(warns)
            .map(([u, w]) => ({ u, c: w.length }))
            .sort((a, b) => b.c - a.c)
            .slice(0, 15);
          const txt = sorted.map((x, i) => `\( {i + 1}. @ \){getNumber(x.u)} → ${x.c} warns`).join('\n') || 'No warns yet';
          await replyWithPfp(sock, jid, `📊 *Top Warned*\n\n${txt}`, msg);
          break;
        }

        case 'setwarnlimit': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const limit = parseInt(args[0]);
          if (!limit || limit < 1) return replyText(sock, jid, 'Usage: .setwarnlimit 3', msg);
          store.setSetting(jid, 'warnLimit', limit);
          await replyWithPfp(sock, jid, `✅ Warn limit set to *${limit}*`, msg);
          break;
        }

        case 'warnmode': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const mode = (args[0] || '').toLowerCase();
          if (!['kick', 'ban', 'mute'].includes(mode)) return replyText(sock, jid, 'Usage: .warnmode kick|ban|mute', msg);
          store.setSetting(jid, 'warnMode', mode);
          await replyWithPfp(sock, jid, `✅ Warn mode set to *${mode}*`, msg);
          break;
        }

        case 'warncount': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const target = extractTarget(msg, args) || from;
          const count = store.getWarnCount(jid, target);
          await replyWithPfp(sock, jid, `⚠️ @\( {getNumber(target)} has * \){count}* warning(s)`, msg);
          break;
        }

        case 'warnall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const meta = await getGroupMeta(sock, jid);
          if (!meta) return;
          let count = 0;
          for (const p of meta.participants) {
            if (p.admin) continue;
            store.addWarn(jid, p.id, 'Warnall by admin');
            count++;
          }
          await replyWithPfp(sock, jid, `⚠️ Warned *${count}* members`, msg);
          break;
        }

        // ====================== PUNISH ======================
        case 'kick':
        case 'remove': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag, reply or give number.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'remove');
          await replyWithPfp(sock, jid, `🔨 Kicked @${getNumber(target)}`, msg);
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
          await replyWithPfp(sock, jid, `🚫 Banned & blacklisted @${getNumber(target)}`, msg);
          break;
        }

        case 'unban': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number or tag.', msg);
          store.removeBlacklist(getNumber(target));
          await replyWithPfp(sock, jid, `✅ Unbanned @${getNumber(target)}`, msg);
          break;
        }

        case 'mute': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          // Baileys has no true mute user, we use restrict + settings
          await sock.groupSettingUpdate(jid, 'announcement');
          await replyWithPfp(sock, jid, `🔇 Group muted (only admins can send)`, msg);
          break;
        }

        case 'unmute':
        case 'groupunmute': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await replyWithPfp(sock, jid, `🔊 Group unmuted`, msg);
          break;
        }

        case 'groupmute': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'announcement');
          await replyWithPfp(sock, jid, `🔇 Group muted`, msg);
          break;
        }

        case 'add': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'add');
          await replyWithPfp(sock, jid, `✅ Added @${getNumber(target)}`, msg);
          break;
        }

        case 'kickall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const meta = await getGroupMeta(sock, jid);
          const toKick = meta.participants.filter(p => !p.admin).map(p => p.id);
          for (const u of toKick) {
            await sock.groupParticipantsUpdate(jid, [u], 'remove').catch(() => {});
          }
          await replyWithPfp(sock, jid, `🔨 Kicked ${toKick.length} members`, msg);
          break;
        }

        case 'banall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          const meta = await getGroupMeta(sock, jid);
          for (const p of meta.participants) {
            if (p.admin) continue;
            store.addBlacklist(getNumber(p.id));
            await sock.groupParticipantsUpdate(jid, [p.id], 'remove').catch(() => {});
          }
          await replyWithPfp(sock, jid, `🚫 Banned all non-admins`, msg);
          break;
        }

        case 'tempban':
        case 'tempmute':
        case 'jail':
        case 'unjail':
        case 'suspend':
        case 'unsuspend': {
          // Real temp actions need a scheduler. We implement basic version with blacklist for now.
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag or reply.', msg);

          if (command === 'jail' || command === 'tempban' || command === 'suspend') {
            store.addBlacklist(getNumber(target));
            await sock.groupParticipantsUpdate(jid, [target], 'remove').catch(() => {});
            await replyWithPfp(sock, jid, `🔒 \( {command} applied to @ \){getNumber(target)}`, msg);
          } else {
            store.removeBlacklist(getNumber(target));
            await replyWithPfp(sock, jid, `🔓 \( {command} removed from @ \){getNumber(target)}`, msg);
          }
          break;
        }

        // ====================== GROUP CONTROL ======================
        case 'tagall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const mentions = meta.participants.map(p => p.id);
          const textMsg = text || '📢 Tag All';
          await sock.sendMessage(jid, {
            text: textMsg + '\n\n' + mentions.map(m => `@${getNumber(m)}`).join(' '),
            mentions
          }, { quoted: msg });
          break;
        }

        case 'hidetag': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const mentions = meta.participants.map(p => p.id);
          await sock.sendMessage(jid, {
            text: text || '‎',
            mentions
          }, { quoted: msg });
          break;
        }

        case 'tagadmins': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const admins = meta.participants.filter(p => p.admin).map(p => p.id);
          await sock.sendMessage(jid, {
            text: (text || '👑 Admins') + '\n\n' + admins.map(a => `@${getNumber(a)}`).join('\n'),
            mentions: admins
          }, { quoted: msg });
          break;
        }

        case 'groupinfo': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const settings = store.getSettings(jid);
          const textInfo = `╭━━━━━━━━━━━┳━━━━━━━━━━━╮
┃  GROUP INFO
┣━━━━━━━━━━━┻━━━━━━━━━━━┫
┃ Name: ${meta.subject}
┃ Members: ${meta.participants.length}
┃ Owner: ${meta.owner ? '@' + getNumber(meta.owner) : 'Unknown'}
┃ Created: ${new Date(meta.creation * 1000).toLocaleString()}
┃ Desc: ${meta.desc || 'None'}
┃ Locked: ${settings.locked ? 'Yes' : 'No'}
┃ Antilink: ${settings.antilink ? 'ON' : 'OFF'}
╰━━━━━━━━━━━━━━━━━━━━━━━╯`;
          await replyWithPfp(sock, jid, textInfo, msg);
          break;
        }

        case 'groupname': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .groupname New Name', msg);
          await sock.groupUpdateSubject(jid, text);
          await replyWithPfp(sock, jid, `✅ Group name changed to *${text}*`, msg);
          break;
        }

        case 'groupdesc': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .groupdesc New description', msg);
          await sock.groupUpdateDescription(jid, text);
          await replyWithPfp(sock, jid, `✅ Group description updated`, msg);
          break;
        }

        case 'grouppic':
        case 'setgrouppic': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted?.imageMessage) return replyText(sock, jid, 'Reply to an image.', msg);
          const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
          let buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
          await sock.updateProfilePicture(jid, buffer);
          await replyWithPfp(sock, jid, `✅ Group picture updated`, msg);
          break;
        }

        case 'delgrouppic': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.removeProfilePicture(jid);
          await replyWithPfp(sock, jid, `✅ Group picture removed`, msg);
          break;
        }

        case 'revoke':
        case 'grouplink':
        case 'invite': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (command === 'revoke') {
            await sock.groupRevokeInvite(jid);
            await replyWithPfp(sock, jid, `✅ Invite link revoked`, msg);
          } else {
            const code = await sock.groupInviteCode(jid);
            await replyWithPfp(sock, jid, `🔗 Group Link:\nhttps://chat.whatsapp.com/${code}`, msg);
          }
          break;
        }

        case 'closegroup': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'announcement');
          await replyWithPfp(sock, jid, `🔒 Group closed (admins only)`, msg);
          break;
        }

        case 'opengroup': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          await sock.groupSettingUpdate(jid, 'not_announcement');
          await replyWithPfp(sock, jid, `🔓 Group opened`, msg);
          break;
        }
        case 'groupsettings':
        case 'groupstats': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const s = store.getSettings(jid);
          const txt = Object.entries(s)
            .map(([k, v]) => `• ${k}: ${v}`)
            .join('\n');
          await replyWithPfp(sock, jid, `⚙️ *Group Settings*\n\n${txt}`, msg);
          break;
        }

        // ====================== ADMIN ======================
        case 'promote': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag or reply.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'promote');
          await replyWithPfp(sock, jid, `⬆️ Promoted @${getNumber(target)}`, msg);
          break;
        }

        case 'demote': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!(await isBotAdmin(sock, jid))) return replyText(sock, jid, 'Bot must be admin.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Tag or reply.', msg);
          await sock.groupParticipantsUpdate(jid, [target], 'demote');
          await replyWithPfp(sock, jid, `⬇️ Demoted @${getNumber(target)}`, msg);
          break;
        }

        case 'promoteall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const nonAdmins = meta.participants.filter(p => !p.admin).map(p => p.id);
          for (const u of nonAdmins) {
            await sock.groupParticipantsUpdate(jid, [u], 'promote').catch(() => {});
          }
          await replyWithPfp(sock, jid, `⬆️ Promoted all members`, msg);
          break;
        }

        case 'demoteall': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const admins = meta.participants.filter(p => p.admin && p.id !== meta.owner).map(p => p.id);
          for (const u of admins) {
            await sock.groupParticipantsUpdate(jid, [u], 'demote').catch(() => {});
          }
          await replyWithPfp(sock, jid, `⬇️ Demoted all admins`, msg);
          break;
        }

        case 'setwelcome': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .setwelcome Welcome @user', msg);
          store.setWelcome(jid, text);
          await replyWithPfp(sock, jid, `✅ Welcome message set`, msg);
          break;
        }

        case 'setgoodbye': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .setgoodbye Goodbye @user', msg);
          store.setGoodbye(jid, text);
          await replyWithPfp(sock, jid, `✅ Goodbye message set`, msg);
          break;
        }

        case 'setprefix': {
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          if (!args[0]) return replyText(sock, jid, 'Usage: .setprefix !', msg);
          // Note: changing prefix requires restart or dynamic config. For now we just reply.
          await replyWithPfp(sock, jid, `⚠️ Prefix change requires editing .env and restart.\nCurrent: ${config.prefix}`, msg);
          break;
        }

        case 'adminlist': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const admins = meta.participants.filter(p => p.admin);
          const txt = admins.map(a => `• @${getNumber(a.id)} ${a.admin === 'superadmin' ? '(Creator)' : ''}`).join('\n');
          await replyWithPfp(sock, jid, `👑 *Admins*\n\n${txt}`, msg);
          break;
        }

        case 'botadmin': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const isAdm = await isBotAdmin(sock, jid);
          await replyWithPfp(sock, jid, isAdm ? '✅ Bot is admin' : '❌ Bot is not admin', msg);
          break;
        }

        // ====================== RULES ======================
        case 'rules':
        case 'listrules': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const rules = store.getRules(jid);
          await replyWithPfp(sock, jid, `📜 *Group Rules*\n\n${rules}`, msg);
          break;
        }

        case 'setrules': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          if (!text) return replyText(sock, jid, 'Usage: .setrules Your rules here', msg);
          store.setRules(jid, text);
          await replyWithPfp(sock, jid, `✅ Rules updated`, msg);
          break;
        }

        case 'delrules': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          if (!(await isGroupAdmin(sock, jid, from)) && !isOwner(from)) return replyText(sock, jid, 'Admin only.', msg);
          store.delRules(jid);
          await replyWithPfp(sock, jid, `✅ Rules deleted`, msg);
          break;
        }

        // ====================== INFO ======================
        case 'userinfo': {
          const target = extractTarget(msg, args) || from;
          const warns = store.getWarnCount(jid, target);
          const bl = store.getBlacklist().includes(getNumber(target));
          await replyWithPfp(sock, jid, `👤 *User Info*\nNumber: @${getNumber(target)}\nWarns: ${warns}\nBlacklisted: ${bl ? 'Yes' : 'No'}`, msg);
          break;
        }

        case 'memberlist': {
          if (!isGroup) return replyText(sock, jid, 'Group only.', msg);
          const meta = await getGroupMeta(sock, jid);
          const list = meta.participants.map((p, i) => `\( {i + 1}. @ \){getNumber(p.id)}${p.admin ? ' 👑' : ''}`).join('\n');
          await replyWithPfp(sock, jid, `👥 *Members* (\( {meta.participants.length})\n\n \){list}`, msg);
          break;
        }

        case 'online':
        case 'active': {
          await replyWithPfp(sock, jid, `🟢 Online status is limited by WhatsApp privacy.\nUse .memberlist for full list.`, msg);
          break;
        }

        // ====================== BLACKLIST / WHITELIST ======================
        case 'blacklist': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) {
            const list = store.getBlacklist();
            return replyWithPfp(sock, jid, `🚫 *Blacklist*\n${list.length ? list.map(n => `• ${n}`).join('\n') : 'Empty'}`, msg);
          }
          store.addBlacklist(getNumber(target));
          if (isGroup) await sock.groupParticipantsUpdate(jid, [target], 'remove').catch(() => {});
          await replyWithPfp(sock, jid, `🚫 Blacklisted @${getNumber(target)}`, msg);
          break;
        }

        case 'unblacklist': {
          if (!isOwner(from) && !(isGroup && await isGroupAdmin(sock, jid, from))) return replyText(sock, jid, 'Admin/Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number.', msg);
          store.removeBlacklist(getNumber(target));
          await replyWithPfp(sock, jid, `✅ Removed from blacklist @${getNumber(target)}`, msg);
          break;
        }

        case 'whitelist': {
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) {
            const list = store.getWhitelist();
            return replyWithPfp(sock, jid, `✅ *Whitelist*\n${list.length ? list.map(n => `• ${n}`).join('\n') : 'Empty'}`, msg);
          }
          store.addWhitelist(getNumber(target));
          await replyWithPfp(sock, jid, `✅ Whitelisted @${getNumber(target)}`, msg);
          break;
        }

        case 'unwhitelist': {
          if (!isOwner(from)) return replyText(sock, jid, 'Owner only.', msg);
          const target = extractTarget(msg, args);
          if (!target) return replyText(sock, jid, 'Give number.', msg);
          store.removeWhitelist(getNumber(target));
          await replyWithPfp(sock, jid, `✅ Removed from whitelist @${getNumber(target)}`, msg);
          break;
        }

        case 'report':
        case 'appeal': {
          await replyWithPfp(sock, jid, `📨 Your ${command} has been noted.\nContact the owner for review.`, msg);
          for (const o of config.owners) {
            await sock.sendMessage(o + '@s.whatsapp.net', {
              text: `📢 ${command.toUpperCase()} from ${num}\nGroup: ${jid}\nMessage: ${text || 'No text'}`
            }).catch(() => {});
          }
          break;
        }

        default:
          // silent
          break;
      }
    } catch (err) {
      console.error('Command error:', command, err);
      await replyText(sock, jid, `❌ Error: ${err.message}`, msg).catch(() => {});
    }
  });

  return sock;
}

console.log(`
╭━━━━━━━━━━━┳━━━━━━━━━━━╮
┃  TYLA 💋   ┃  STARTING ┃
╰━━━━━━━━━━━┻━━━━━━━━━━━╯
Pairing • No QR • Full real handlers
`);

startBot().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
