const axios = require('axios')
const config = require('../config')

async function getPfpBuffer() {
  const res = await axios.get(config.botPfp, { responseType: 'arraybuffer' })
  return Buffer.from(res.data)
}

async function newsletterReply(sock, from, text, msg) {
  const thumb = await getPfpBuffer()
  await sock.sendMessage(from, {
    text,
    contextInfo: {
      isForwarded: true,
      forwardingScore: 999,
      forwardedNewsletterMessageInfo: {
        newsletterJid: config.newsletterJid,
        serverMessageId: 1,
        newsletterName: config.newsletterName
      },
      externalAdReply: {
        title: 'TYLA 💋',
        body: 'Moderator Bot',
        thumbnail: thumb,
        thumbnailUrl: config.botPfp,
        sourceUrl: 'https://chat.whatsapp.com/TYLA',
        mediaType: 1,
        renderLargerThumbnail: false // small tiny scale
      }
    }
  }, { quoted: msg })
}

module.exports = { newsletterReply, getPfpBuffer }
