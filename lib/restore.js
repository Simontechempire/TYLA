const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.ensureDirSync(DATA_DIR);

const files = {
  settings: path.join(DATA_DIR, 'settings.json'),
  warns: path.join(DATA_DIR, 'warns.json'),
  blacklist: path.join(DATA_DIR, 'blacklist.json'),
  whitelist: path.join(DATA_DIR, 'whitelist.json'),
  rules: path.join(DATA_DIR, 'rules.json'),
  badwords: path.join(DATA_DIR, 'badwords.json'),
  welcome: path.join(DATA_DIR, 'welcome.json'),
  goodbye: path.join(DATA_DIR, 'goodbye.json')
};

function load(file, def = {}) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeJsonSync(file, def, { spaces: 2 });
      return def;
    }
    return fs.readJsonSync(file);
  } catch {
    return def;
  }
}

function save(file, data) {
  fs.writeJsonSync(file, data, { spaces: 2 });
}

// ===== SETTINGS (per group) =====
function getSettings(gid) {
  const all = load(files.settings, {});
  if (!all[gid]) {
    all[gid] = {
      antilink: false,
      antibot: false,
      antispam: false,
      antifake: false,
      antiviewonce: false,
      antisticker: false,
      antiforeign: false,
      antidelete: false,
      antitag: false,
      antidemote: false,
      antipromote: false,
      anticall: false,
      antimedia: false,
      antilocation: false,
      anticontact: false,
      antipoll: false,
      antishare: false,
      antivideo: false,
      antiaudio: false,
      antidocument: false,
      antigcstatus: false,
      antigmention: false,
      antichannel: false,
      antistatusmention: false,
      antilinkstatus: false,
      antibadword: false,
      antilinkaction: 'delete', // delete | warn | kick
      warnLimit: 3,
      warnMode: 'kick', // kick | ban | mute
      welcome: false,
      goodbye: false,
      adminonly: false,
      locked: false
    };
    save(files.settings, all);
  }
  return all[gid];
}

function setSetting(gid, key, value) {
  const all = load(files.settings, {});
  if (!all[gid]) all[gid] = getSettings(gid);
  all[gid][key] = value;
  save(files.settings, all);
  return all[gid];
}

// ===== WARNS =====
function getWarns(gid) {
  const all = load(files.warns, {});
  return all[gid] || {};
}

function addWarn(gid, user, reason = 'No reason') {
  const all = load(files.warns, {});
  if (!all[gid]) all[gid] = {};
  if (!all[gid][user]) all[gid][user] = [];
  all[gid][user].push({ reason, time: Date.now() });
  save(files.warns, all);
  return all[gid][user].length;
}

function removeWarn(gid, user, count = 1) {
  const all = load(files.warns, {});
  if (!all[gid] || !all[gid][user]) return 0;
  all[gid][user].splice(0, count);
  if (all[gid][user].length === 0) delete all[gid][user];
  save(files.warns, all);
  return all[gid][user] ? all[gid][user].length : 0;
}

function resetWarns(gid, user = null) {
  const all = load(files.warns, {});
  if (!all[gid]) return;
  if (user) delete all[gid][user];
  else all[gid] = {};
  save(files.warns, all);
}

function getWarnCount(gid, user) {
  const warns = getWarns(gid);
  return warns[user] ? warns[user].length : 0;
}

// ===== BLACKLIST / WHITELIST =====
function getBlacklist() {
  return load(files.blacklist, []);
}
function addBlacklist(num) {
  const list = getBlacklist();
  if (!list.includes(num)) {
    list.push(num);
    save(files.blacklist, list);
  }
}
function removeBlacklist(num) {
  let list = getBlacklist();
  list = list.filter(n => n !== num);
  save(files.blacklist, list);
}

function getWhitelist() {
  return load(files.whitelist, []);
}
function addWhitelist(num) {
  const list = getWhitelist();
  if (!list.includes(num)) {
    list.push(num);
    save(files.whitelist, list);
  }
}
function removeWhitelist(num) {
  let list = getWhitelist();
  list = list.filter(n => n !== num);
  save(files.whitelist, list);
}

// ===== RULES =====
function getRules(gid) {
  const all = load(files.rules, {});
  return all[gid] || 'No rules set.';
}
function setRules(gid, text) {
  const all = load(files.rules, {});
  all[gid] = text;
  save(files.rules, all);
}
function delRules(gid) {
  const all = load(files.rules, {});
  delete all[gid];
  save(files.rules, all);
}

// ===== BADWORDS =====
function getBadwords() {
  return load(files.badwords, []);
}
function addBadword(word) {
  const list = getBadwords();
  const w = word.toLowerCase();
  if (!list.includes(w)) {
    list.push(w);
    save(files.badwords, list);
  }
}
function delBadword(word) {
  let list = getBadwords();
  list = list.filter(w => w !== word.toLowerCase());
  save(files.badwords, list);
}

// ===== WELCOME / GOODBYE =====
function getWelcome(gid) {
  const all = load(files.welcome, {});
  return all[gid] || 'Welcome @user to the group!';
}
function setWelcome(gid, text) {
  const all = load(files.welcome, {});
  all[gid] = text;
  save(files.welcome, all);
}
function getGoodbye(gid) {
  const all = load(files.goodbye, {});
  return all[gid] || 'Goodbye @user';
}
function setGoodbye(gid, text) {
  const all = load(files.goodbye, {});
  all[gid] = text;
  save(files.goodbye, all);
}

module.exports = {
  getSettings, setSetting,
  getWarns, addWarn, removeWarn, resetWarns, getWarnCount,
  getBlacklist, addBlacklist, removeBlacklist,
  getWhitelist, addWhitelist, removeWhitelist,
  getRules, setRules, delRules,
  getBadwords, addBadword, delBadword,
  getWelcome, setWelcome, getGoodbye, setGoodbye
};
