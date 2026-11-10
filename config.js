require('dotenv').config();

module.exports = {
  phone: process.env.BOT_PHONE || '',
  prefix: process.env.PREFIX || '.',
  owners: (process.env.OWNERS || '').split(',').map(n => n.trim()).filter(Boolean),
  botName: process.env.BOT_NAME || 'TYLA 💋',
  authDir: process.env.AUTH_DIR || './auth_info',
  newsletterJid: process.env.NEWSLETTER_JID || '',
  botPfp: process.env.BOT_PFP || 'https://i.postimg.cc/SxjL0Yjc/99f8f6a3bdf94a5e43d3e2975e9502fc.jpg',
  // Commands count shown in menu
  cmdCount: 110
};
