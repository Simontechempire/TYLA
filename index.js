const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const fs = require('fs')
const axios = require('axios')
const express = require('express')
const config = require('./config')
const menuText = require('./lib/menu')
const { newsletterReply, getPfpBuffer } = require('./lib/func')

const app = express()
app.use(express.static('public'))
app.get('/pair', async (req, res) => {
  if (!global.pairCode) return res.json({ error: 'TYLA still starting... wait 10s then refresh' })
  res.json({ code: global.pairCode })
})
app.listen(3000, () => console.log('TYLA Web: http://localhost:3000'))

let db = { groups: {}, warns: {}, blacklist: [], whitelist: [], badwords: ['fuck','shit','bitch'] }
if (fs.existsSync('./database.json')) db = JSON.parse(fs.readFileSync('./database.json'))
const saveDB = () => fs.writeFileSync('./database.json', JSON.stringify(db, null, 2))
const g = (id) => { if (!db.groups[id]) db.groups[id] = { antilink:false, antibot:false, antispam:false, antifake:false, antiviewonce:false, antisticker:false, antiforeign:false, antidelete:false, antitag:false, antidemote:false, antipromote:false, anticall:false, antimedia:false, antilocation:false, anticontact:false, antipoll:false, antishare:false, antivideo:false, antiaudio:false, antidocument:false, antigcstatus:false, antigmention:false, antichannel:false, antistatusmention:false, antilinkstatus:false, antibadword:false, warnlimit:3, welcome:'', goodbye:'', rules:'', antilinkaction:'delete', adminonly:false }; return db.groups[id] }
const getWarn = (gid, uid) => db.warns[`${gid}_${uid}`] || 0
const setWarn = (gid, uid, v) => { db.warns[`${gid}_${uid}`] = v; saveDB() }

async function startTYLA() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionFolder)
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: ['TYLA', 'Chrome', '1.0'] })
  sock.ev.on('creds.update', saveCreds)

  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(config.pairingNumber)
        global.pairCode = code
        console.log('TYLA PAIRING CODE:', code)
      } catch (e) { console.log('Pairing error', e.message) }
    }, 3000)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) startTYLA()
    if (connection === 'open') {
      console.log('TYLA CONNECTED 💋')
      try { const buf = await getPfpBuffer(); await sock.updateProfilePicture(sock.user.id, buf) } catch {}
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || !msg.key.remoteJid) return
    const from = msg.key.remoteJid
    const isGroup = from.endsWith('@g.us')
    const sender = msg.key.participant || msg.key.remoteJid
    const senderNum = sender.split('@')[0]
    const botNum = sock.user ? sock.user.id.split(':')[0] : ''
    const m = msg.message
    const body = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || ''
    const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || {}
    const mentioned = ctx.mentionedJid || []
    const quoted = ctx.participant || null
    const reply = (text) => newsletterReply(sock, from, text, msg)
    const del = async () => { try { await sock.sendMessage(from, { delete: msg.key }) } catch {} }

    let isAdmin = false, isBotAdmin = false, meta = null
    if (isGroup) {
      try {
        meta = await sock.groupMetadata(from)
        isAdmin = meta.participants.find(p => p.id === sender)?.admin != null
        isBotAdmin = meta.participants.find(p => p.id.includes(botNum))?.admin != null
        if (!msg.key.fromMe && !isAdmin) {
          const cfg = g(from)
          const txt = body.toLowerCase()
          const hasLink = /https?:\/\/|wa\.me\/|chat\.whatsapp\.com|t\.me\/|discord\.gg|instagram\.com|youtube\.com|tiktok\.com/i.test(body)
          const hasChannel = /whatsapp\.com\/channel\//i.test(body)
          const hasGcStatus = cfg.antigcstatus && hasLink && /status/i.test(body)
          const hasGmention = cfg.antigmention && (mentioned.length >= 5 || body.includes('@all') || body.includes('@everyone'))
          const hasBad = cfg.antibadword && db.badwords.some(w => txt.includes(w))
          const hasSticker = !!m.stickerMessage
          const hasViewOnce = !!m.viewOnceMessage || !!m.viewOnceMessageV2 || !!m.viewOnceMessageV2Extension
          const hasForeign = cfg.antiforeign && !['234','233','225'].some(c => senderNum.startsWith(c))
          const hasMedia = !!(m.imageMessage || m.videoMessage)
          const hasAudio = !!m.audioMessage
          const hasDoc = !!m.documentMessage
          const hasPoll = !!m.pollCreationMessage || !!m.pollUpdateMessage
          const hasContact = !!m.contactMessage || !!m.contactsArrayMessage
          const hasLocation = !!m.locationMessage || !!m.liveLocationMessage
          let shouldDel = false
          if (cfg.antilink && hasLink) shouldDel = true
          if (cfg.antichannel && hasChannel) shouldDel = true
          if (hasGcStatus) shouldDel = true
          if (hasGmention) shouldDel = true
          if (cfg.antistatusmention && body.includes('status') && mentioned.length > 0) shouldDel = true
          if (cfg.antilinkstatus && hasLink && body.includes('status')) shouldDel = true
          if (hasBad) shouldDel = true
          if (cfg.antisticker && hasSticker) shouldDel = true
          if (cfg.antiviewonce && hasViewOnce) shouldDel = true
          if (cfg.antiforeign && hasForeign) shouldDel = true
          if (cfg.antimedia && hasMedia) shouldDel = true
          if (cfg.antiaudio && hasAudio) shouldDel = true
          if (cfg.antidocument && hasDoc) shouldDel = true
          if (cfg.antipoll && hasPoll) shouldDel = true
          if (cfg.anticontact && hasContact) shouldDel = true
          if (cfg.antilocation && hasLocation) shouldDel = true
          if (cfg.antivideo && !!m.videoMessage) shouldDel = true
          if (cfg.antishare && ctx.isForwarded) shouldDel = true
          if (cfg.antitag && mentioned.length > 0 && mentioned.length < 5) shouldDel = false
          if (shouldDel) {
            await del()
            if (cfg.antilinkaction === 'warn' && hasLink) {
              const w = getWarn(from, sender) + 1; setWarn(from, sender, w)
              if (w >= cfg.warnlimit) { await sock.groupParticipantsUpdate(from, [sender], 'remove'); setWarn(from, sender, 0); await reply(`@${senderNum} kicked - warn limit`) }
              else await reply(`Warn ${w}/${cfg.warnlimit} - not allowed`)
            }
            if (cfg.antilinkaction === 'kick' && hasLink) { await sock.groupParticipantsUpdate(from, [sender], 'remove') }
            return
          }
        }
      } catch {}
    }

    if (!body.startsWith(config.prefix)) return
    const args = body.slice(config.prefix.length).trim().split(/ +/)
    const command = args.shift().toLowerCase()
    const text = args.join(' ')
    const target = mentioned[0] || (quoted ? quoted : null) || (args[0] ? args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null)
    const targetNum = target ? target.split('@')[0] : ''
    const isOwner = config.ownerNumber.includes(senderNum)
    const needAdmin = async () => { if (!isGroup) { await reply('Group only'); return false } if (!isAdmin && !isOwner) { await reply('Admin only'); return false } if (!isBotAdmin) { await reply('Make TYLA admin first'); return false } return true }
    const needGroup = async () => { if (!isGroup) { await reply('Group only'); return false } return true }
    switch (command) {
      case 'menu': case 'help': { await reply(menuText(config.prefix)); break }
      case 'ping': { await reply(`TYLA online 💋`); break }
      case 'owner': { await reply(`Owner: @${config.ownerNumber[0]}`); break }
      case 'rules': { if (!await needGroup()) break; await reply(g(from).rules || 'No rules set'); break }
      case 'setrules': { if (!await needAdmin()) break; g(from).rules = text; saveDB(); await reply('Rules updated'); break }
      case 'delrules': { if (!await needAdmin()) break; g(from).rules = ''; saveDB(); await reply('Rules deleted'); break }
      case 'listrules': { if (!await needGroup()) break; await reply(g(from).rules || 'No rules'); break }
      case 'report': { await sock.sendMessage(config.ownerNumber[0] + '@s.whatsapp.net', { text: `REPORT from @${senderNum} in ${from}: ${text}` }); await reply('Report sent to owner'); break }
      case 'appeal': { await reply('Appeal noted. Owner go review am.'); break }
      case 'checkwarn': case 'userinfo': { if (!await needGroup()) break; const u = target || sender; await reply(`User: @${u.split('@')[0]}\nWarns: ${getWarn(from, u)}/${g(from).warnlimit}`); break }
      case 'memberlist': { if (!await needGroup()) break; await reply(meta.participants.map((p, i) => `${i + 1}. @${p.id.split('@')[0]} ${p.admin ? '(admin)' : ''}`).join('\n')); break }
      case 'online': { if (!await needGroup()) break; await reply(`Online check - Members: ${meta.participants.length}`); break }
      case 'active': { if (!await needGroup()) break; await reply('TYLA dey monitor group - active'); break }
      case 'topwarned': { if (!await needGroup()) break; const list = Object.entries(db.warns).filter(([k]) => k.startsWith(from)).sort((a, b) => b[1] - a[1]).slice(0, 10); await reply(list.length ? list.map(([k, v], i) => `${i + 1}. @${k.split('_')[1].split('@')[0]} - ${v} warns`).join('\n') : 'No warns'); break }
      case 'blacklist': { if (!isOwner) { await reply('Owner only'); break } if (!target) { await reply('Tag user'); break } if (!db.blacklist.includes(target)) db.blacklist.push(target); saveDB(); await reply(`@${targetNum} blacklisted`); break }
      case 'unblacklist': { if (!isOwner) break; db.blacklist = db.blacklist.filter(x => x !== target); saveDB(); await reply('Removed from blacklist'); break }
      case 'whitelist': { if (!isOwner) break; if (!target) { await reply('Tag user'); break } if (!db.whitelist.includes(target)) db.whitelist.push(target); saveDB(); await reply(`@${targetNum} whitelisted`); break }
      case 'unwhitelist': { if (!isOwner) break; db.whitelist = db.whitelist.filter(x => x !== target); saveDB(); await reply('Removed from whitelist'); break }
      case 'antilink': case 'antibot': case 'antispam': case 'antifake': case 'antiviewonce': case 'antisticker': case 'antiforeign': case 'antidelete': case 'antitag': case 'antidemote': case 'antipromote': case 'anticall': case 'antimedia': case 'antilocation': case 'anticontact': case 'antipoll': case 'antishare': case 'antivideo': case 'antiaudio': case 'antidocument': case 'antigcstatus': case 'antigmention': case 'antichannel': case 'antistatusmention': case 'antilinkstatus': case 'antibadword': { if (!await needAdmin()) break; const on = text.toLowerCase() === 'on'; g(from)[command] = on; saveDB(); await reply(`${command} ${on ? 'ON ✅ - delete on' : 'OFF ❌'}`); break }
      case 'antilinkaction': { if (!await needAdmin()) break; g(from).antilinkaction = ['delete','warn','kick'].includes(text.toLowerCase()) ? text.toLowerCase() : 'delete'; saveDB(); await reply(`Antilink action: ${g(from).antilinkaction}`); break }
      case 'addbadword': { if (!await needAdmin()) break; if (!text) { await reply('Provide word'); break } db.badwords.push(text.toLowerCase()); saveDB(); await reply(`Badword added: ${text}`); break }
      case 'delbadword': { if (!await needAdmin()) break; db.badwords = db.badwords.filter(w => w !== text.toLowerCase()); saveDB(); await reply('Badword removed'); break }
      case 'badwordlist': { await reply(`Badwords: ${db.badwords.join(', ')}`); break }
      case 'warn': { if (!await needAdmin()) break; if (!target) { await reply('Tag user to warn'); break } const w = getWarn(from, target) + 1; setWarn(from, target, w); if (w >= g(from).warnlimit) { await sock.groupParticipantsUpdate(from, [target], 'remove'); setWarn(from, target, 0); await reply(`@${targetNum} kicked - ${w}/${g(from).warnlimit} warns`) } else await reply(`@${targetNum} warned ${w}/${g(from).warnlimit}`); break }
      case 'warnings': { if (!await needGroup()) break; const u = target || sender; await reply(`@${u.split('@')[0]} - ${getWarn(from, u)}/${g(from).warnlimit} warns`); break }
      case 'resetwarn': case 'unwarn': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } setWarn(from, target, 0); await reply(`Warns cleared for @${targetNum}`); break }
      case 'warnlist': { if (!await needGroup()) break; const list = Object.entries(db.warns).filter(([k, v]) => k.startsWith(from) && v > 0); await reply(list.length ? list.map(([k, v]) => `@${k.split('_')[1].split('@')[0]}: ${v}`).join('\n') : 'No warns'); break }
      case 'setwarnlimit': { if (!await needAdmin()) break; g(from).warnlimit = parseInt(text) || 3; saveDB(); await reply(`Warn limit: ${g(from).warnlimit}`); break }
      case 'warnall': { if (!await needAdmin()) break; for (const p of meta.participants) { if (!p.admin) setWarn(from, p.id, getWarn(from, p.id) + 1) } await reply('All members warned +1'); break }
      case 'clearwarns': { if (!await needAdmin()) break; Object.keys(db.warns).filter(k => k.startsWith(from)).forEach(k => delete db.warns[k]); saveDB(); await reply('All warns cleared'); break }
      case 'warnmode': { if (!await needAdmin()) break; await reply(`Warn mode: kick at ${g(from).warnlimit}`); break }
      case 'warncount': { if (!await needGroup()) break; await reply(`Total warns: ${Object.entries(db.warns).filter(([k]) => k.startsWith(from)).reduce((a, [, v]) => a + v, 0)}`); break }
      case 'kick': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'remove'); await reply(`@${targetNum} kicked`); break }
      case 'ban': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'remove'); if (!db.blacklist.includes(target)) db.blacklist.push(target); saveDB(); await reply(`@${targetNum} banned`); break }
      case 'unban': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } db.blacklist = db.blacklist.filter(x => x !== target); saveDB(); await reply(`@${targetNum} unbanned`); break }
      case 'mute': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'remove'); await reply(`@${targetNum} muted (removed)`); break }
      case 'unmute': { await reply('Unmuted - send invite to rejoin'); break }
      case 'add': { if (!await needAdmin()) break; const num = text.replace(/[^0-9]/g, ''); if (!num) { await reply('Provide number: .add 234...'); break } await sock.groupParticipantsUpdate(from, [num + '@s.whatsapp.net'], 'add'); await reply(`Added ${num}`); break }
      case 'remove': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'remove'); await reply(`Removed @${targetNum}`); break }
      case 'suspend': case 'jail': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'remove'); await reply(`@${targetNum} suspended/jailed`); break }
      case 'unsuspend': case 'unjail': { await reply('Unsuspended - send invite to rejoin'); break }
      case 'kickall': { if (!isOwner) { await reply('Owner only'); break } const nonAdmins = meta.participants.filter(p => !p.admin && !p.id.includes(botNum)).map(p => p.id); for (const id of nonAdmins) await sock.groupParticipantsUpdate(from, [id], 'remove'); await reply(`Kicked ${nonAdmins.length} members`); break }
      case 'banall': { if (!isOwner) break; const nonAdmins = meta.participants.filter(p => !p.admin).map(p => p.id); db.blacklist.push(...nonAdmins); saveDB(); for (const id of nonAdmins) await sock.groupParticipantsUpdate(from, [id], 'remove'); await reply('All banned'); break }
      case 'tempban': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } const mins = parseInt(args[1]) || 10; await sock.groupParticipantsUpdate(from, [target], 'remove'); await reply(`@${targetNum} temp banned ${mins}min`); setTimeout(async () => { try { await sock.groupParticipantsUpdate(from, [target], 'add') } catch {} }, mins * 60000); break }
      case 'tempmute': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } const mins = parseInt(args[1]) || 10; await sock.groupParticipantsUpdate(from, [target], 'remove'); await reply(`@${targetNum} temp muted ${mins}min`); break }
      case 'lock': case 'closegroup': { if (!await needAdmin()) break; await sock.groupSettingUpdate(from, 'announcement'); await reply('Group locked - admins only fit talk'); break }
      case 'unlock': case 'opengroup': { if (!await needAdmin()) break; await sock.groupSettingUpdate(from, 'not_announcement'); await reply('Group unlocked'); break }
      case 'groupmute': { if (!await needAdmin()) break; await sock.groupSettingUpdate(from, 'announcement'); await reply('Group muted'); break }
      case 'groupunmute': { if (!await needAdmin()) break; await sock.groupSettingUpdate(from, 'not_announcement'); await reply('Group unmuted'); break }
      case 'tagall': { if (!await needAdmin()) break; await sock.sendMessage(from, { text: `${text || 'TYLA tag all'}\n\n${meta.participants.map(p => `@${p.id.split('@')[0]}`).join(' ')}`, mentions: meta.participants.map(p => p.id) }); break }
      case 'hidetag': { if (!await needAdmin()) break; await sock.sendMessage(from, { text: text || 'TYLA', mentions: meta.participants.map(p => p.id) }); break }
      case 'tagadmins': { if (!await needGroup()) break; const admins = meta.participants.filter(p => p.admin); await sock.sendMessage(from, { text: `${text || 'Admins'} - ${admins.map(p => `@${p.id.split('@')[0]}`).join(' ')}`, mentions: admins.map(p => p.id) }); break }
      case 'groupinfo': { if (!await needGroup()) break; await reply(`Name: ${meta.subject}\nMembers: ${meta.participants.length}\nAdmins: ${meta.participants.filter(p => p.admin).length}\nDesc: ${meta.desc || 'None'}`); break }
      case 'groupname': { if (!await needAdmin()) break; await sock.groupUpdateSubject(from, text); await reply('Group name changed'); break }
      case 'groupdesc': { if (!await needAdmin()) break; await sock.groupUpdateDescription(from, text); await reply('Group desc changed'); break }
      case 'grouppic': case 'setgrouppic': { if (!await needAdmin()) break; const img = m.imageMessage ? await sock.downloadMediaMessage(msg) : null; if (!img) { await reply('Send image with caption .grouppic'); break } await sock.updateProfilePicture(from, img); await reply('Group pic updated'); break }
      case 'delgrouppic': { if (!await needAdmin()) break; await sock.removeProfilePicture(from); await reply('Group pic removed'); break }
      case 'revoke': { if (!await needAdmin()) break; await sock.groupRevokeInvite(from); await reply('Invite link revoked'); break }
      case 'invite': case 'grouplink': { if (!await needAdmin()) break; const code = await sock.groupInviteCode(from); await reply(`https://chat.whatsapp.com/${code}`); break }
      case 'groupsettings': { if (!await needGroup()) break; const cfg = g(from); await reply(`Antilink: ${cfg.antilink}\nAntigcstatus: ${cfg.antigcstatus}\nAntigmention: ${cfg.antigmention}\nWarnlimit: ${cfg.warnlimit}\nAdminOnly: ${cfg.adminonly}`); break }
      case 'groupstats': { if (!await needGroup()) break; await reply(`Members: ${meta.participants.length}\nWarns: ${Object.entries(db.warns).filter(([k]) => k.startsWith(from)).reduce((a, [, v]) => a + v, 0)}`); break }
      case 'promote': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'promote'); await reply(`@${targetNum} promoted`); break }
      case 'demote': { if (!await needAdmin()) break; if (!target) { await reply('Tag user'); break } await sock.groupParticipantsUpdate(from, [target], 'demote'); await reply(`@${targetNum} demoted`); break }
      case 'promoteall': { if (!isOwner) { await reply('Owner only'); break } const mem = meta.participants.filter(p => !p.admin).map(p => p.id); for (const id of mem) await sock.groupParticipantsUpdate(from, [id], 'promote'); await reply('All promoted'); break }
      case 'demoteall': { if (!isOwner) break; const adm = meta.participants.filter(p => p.admin && !p.id.includes(botNum)).map(p => p.id); for (const id of adm) await sock.groupParticipantsUpdate(from, [id], 'demote'); await reply('All demoted'); break }
      case 'welcome': { if (!await needGroup()) break; await reply(g(from).welcome || 'Welcome not set'); break }
      case 'goodbye': { if (!await needGroup()) break; await reply(g(from).goodbye || 'Goodbye not set'); break }
      case 'setwelcome': { if (!await needAdmin()) break; g(from).welcome = text; saveDB(); await reply('Welcome set'); break }
      case 'setgoodbye': { if (!await needAdmin()) break; g(from).goodbye = text; saveDB(); await reply('Goodbye set'); break }
      case 'setprefix': { if (!isOwner) { await reply('Owner only'); break } config.prefix = text || '.'; await reply(`Prefix: ${config.prefix}`); break }
      case 'setbotname': { if (!isOwner) break; await reply('Bot name na TYLA - locked'); break }
      case 'adminlist': { if (!await needGroup()) break; const admins = meta.participants.filter(p => p.admin); await reply(admins.map(p => `@${p.id.split('@')[0]}`).join('\n')); break }
      case 'adminonly': { if (!await needAdmin()) break; g(from).adminonly = text.toLowerCase() === 'on'; saveDB(); await reply(`AdminOnly ${g(from).adminonly ? 'ON' : 'OFF'}`); break }
      case 'botadmin': { if (!await needGroup()) break; await reply(isBotAdmin ? 'TYLA na admin ✅' : 'TYLA NO be admin ❌ - make am admin'); break }
      case 'setowner': { if (!isOwner) break; await reply('Owner locked in config.js / .env'); break }
      default: { break }
    }
  })

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    const cfg = g(id)
    if (action === 'add') {
      if (db.blacklist.includes(participants[0])) { await sock.groupParticipantsUpdate(id, participants, 'remove'); return }
      if (cfg.welcome) await newsletterReply(sock, id, cfg.welcome.replace('@user', `@${participants[0].split('@')[0]}`), { key: { remoteJid: id } })
    }
    if (action === 'remove' && cfg.goodbye) await newsletterReply(sock, id, cfg.goodbye.replace('@user', `@${participants[0].split('@')[0]}`), { key: { remoteJid: id } })
    if (action === 'promote' && cfg.antipromote) { for (const p of participants) await sock.groupParticipantsUpdate(id, [p], 'demote') }
    if (action === 'demote' && cfg.antidemote) { for (const p of participants) await sock.groupParticipantsUpdate(id, [p], 'promote') }
  })
}
startTYLA()
