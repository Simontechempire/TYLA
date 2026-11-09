require('dotenv').config()
module.exports = {
  prefix: '.',
  botName: 'TYLA',
  ownerNumber: [process.env.OWNER_NUMBER || '234XXXXXXXXXX'],
  pairingNumber: process.env.PAIRING_NUMBER || '234XXXXXXXXXX',
  botPfp: 'https://i.postimg.cc/SxjL0Yjc/99f8f6a3bdf94a5e43d3e2975e9502fc.jpg',
  newsletterJid: '120363XXXXXXX@newsletter',
  newsletterName: 'TYLA 💋',
  sessionFolder: 'session'
}
