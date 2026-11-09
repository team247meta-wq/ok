const fs=require('fs');const {spawn}=require('child_process');
function must(s,o,n,l){const i=s.indexOf(o);if(i<0)throw new Error('miss '+l);return s.slice(0,i)+n+s.slice(i+o.length);}
const sid=String(process.env.SUPER_ADMIN_ID||'').trim();
const sids=String(process.env.SUPER_ADMIN_IDS||'');
const admin=String(process.env.ADMIN_CHAT_ID||'').trim();
console.log('DIAG_ADMIN_BEGIN');
console.log('ENV_SUPER_ADMIN_ID_EQ_EXPECTED='+(sid==='7527677281'?'yes':'no'));
console.log('ENV_SUPER_ADMIN_IDS_HAS_EXPECTED='+(sids.split(',').map(x=>x.trim()).includes('7527677281')?'yes':'no'));
console.log('ENV_ADMIN_CHAT_ID_EQ_EXPECTED='+(admin==='7527677281'?'yes':'no'));
console.log('ENV_ADMIN_CHAT_ID_LOOKS_GROUP='+(admin.startsWith('-')?'yes':'no'));
console.log('DIAG_ADMIN_END');
let s=fs.readFileSync('server.js','utf8');
const helpers="function slashCmd(text){const m=String(text||'').trim().match(/^\\/([A-Za-z0-9_]+)(?:@\\w+)?(?:\\s|$)/);return m?m[1].toLowerCase():'';}\nfunction isSlashCmd(text,...names){const c=slashCmd(text);return!!c&&names.some(n=>String(n).toLowerCase()===c);}\nfunction isMenuLabel(text){return ['💰 Tiền vào','💸 Tiền ra','📊 Tổng','🏦 Tạo QR','⚙️ Quản lý','📢 Thông báo','🧾 Chốt sổ'].includes(String(text||'').trim());}\n";
if(!s.includes('function isSlashCmd')&&!s.includes('function slashCmd')){
  s=must(s,"function isSuperAdmin(userId){ return SUPER_ADMIN_IDS.has(String(userId)); }",
    "function isSuperAdmin(userId){ return SUPER_ADMIN_IDS.has(String(userId)); }\nconsole.log('SUPER_ADMIN_COUNT='+SUPER_ADMIN_IDS.size);\nconsole.log('GROUP_SILENCE_HARD=1 ADMIN_MENU=1 SLASH_AT=1');\n"+helpers,
    'inject');
}else if(!s.includes('SUPER_ADMIN_COUNT=')){
  s=must(s,"function isSuperAdmin(userId){ return SUPER_ADMIN_IDS.has(String(userId)); }",
    "function isSuperAdmin(userId){ return SUPER_ADMIN_IDS.has(String(userId)); }\nconsole.log('SUPER_ADMIN_COUNT='+SUPER_ADMIN_IDS.size);\nconsole.log('GROUP_SILENCE_HARD=1 ADMIN_MENU=1 SLASH_AT=1');",
    'bootlog');
}
s=s.split("if(text==='/start'||text==='/help'){").join("if(isSlashCmd(text,'start','help')){");
s=s.split("const guide=text==='/help'?").join("const guide=isSlashCmd(text,'help')?");
s=s.split("if(text==='/cancel'||text==='/huy'){").join("if(isSlashCmd(text,'cancel','huy')){");
s=s.split("if(text==='/group'){").join("if(isSlashCmd(text,'group')){");
s=s.split("||text==='/in'){").join("||isSlashCmd(text,'in')){");
s=s.split("||text==='/out'){").join("||isSlashCmd(text,'out')){");
s=s.split("||text==='/qr'){").join("||isSlashCmd(text,'qr')){");
s=s.split("||text==='/total'){").join("||isSlashCmd(text,'total')){");
s=s.split("if(text==='/list'||text==='/lichsu'){").join("if(isSlashCmd(text,'list','lichsu')){");
s=s.split("||text==='/close'){").join("||isSlashCmd(text,'close')){");
s=s.split("(isPrivate&&text==='💰 Tiền vào')||").join("text==='💰 Tiền vào'||");
s=s.split("(isPrivate&&text==='💸 Tiền ra')||").join("text==='💸 Tiền ra'||");
s=s.split("(isPrivate&&text==='🏦 Tạo QR')||").join("text==='🏦 Tạo QR'||");
s=s.split("(isPrivate&&text==='📊 Tổng')||").join("text==='📊 Tổng'||");
s=s.split("(isPrivate&&text==='📢 Thông báo')||").join("text==='📢 Thông báo'||");
s=s.split("(isPrivate&&text==='🧾 Chốt sổ')||").join("text==='🧾 Chốt sổ'||");
s=s.split("if(isPrivate&&text==='⚙️ Quản lý'){").join("if(text==='⚙️ Quản lý'||isSlashCmd(text,'quanly','manage','admin')){");
if(s.includes('if(!isPrivate&&!isSlash){')&&!s.includes('isMenu=')){
  s=must(s,'const isSlash=routing.isSlashCommand(text, message.entities);\n  const isControl=isPrivate&&routing.isCommandText(text);',
    'const isSlash=routing.isSlashCommand(text, message.entities);\n  const isMenu=isMenuLabel(text);\n  const isControl=isSlash||isMenu;','isMenu');
  s=must(s,'if(!isPrivate&&!isSlash){','if(!isPrivate&&!isSlash&&!isMenu){','gate');
}
if(!s.includes("isSlashCmd(text,'whoami'")){
  const n="if(isSlashCmd(text,'start','help')){";
  if(s.includes(n))s=s.replace(n,"if(isSlashCmd(text,'whoami','me','quyen')){await send(chat.id,`🪪 userId: ${from.id}\\nQuyền: ${access}\\nChat: ${chat.type} ${chat.id}\\nSuperAdmin: ${isSuperAdmin(from.id)?'yes':'no'}`);return;}\n  "+n);
}
fs.writeFileSync('server.js',s);
console.log('GROUP_FIX_APPLIED=1 SLASH_AT=1 ADMIN_MENU=1 INLINE=1');
const child=spawn(process.execPath,['--require','./preload.js','server.js'],{stdio:'inherit',env:process.env});
child.on('exit',c=>process.exit(c==null?1:c));
