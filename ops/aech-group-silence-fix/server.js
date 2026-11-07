'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const vietqr = require('./vietqr');
const qrcore = require('./qrcore');
const stkinfo = require('./stkinfo');
const receivingapi = require('./receivingapi');
const qrimage = require('./qrimage');
const qrparse = require('./qrparse');
const routing = require('./routing');
const groupsapi = require('./groupsapi');
const { buildXlsx } = require('./xlsx');
const { analyzeFreeTextMessage } = require('./message_analyze');
const { validateInitData } = require('./webapp_auth');
const {
  money, parseAmount, parseFeeRatePercent, formatFeeRatePercent, calculateFee,
  parsePaymentText, paymentCompleteness, parseQuickTransaction,
  evaluateExpression, formatRational, looksLikeExpression
} = require('./finance');

// Lưới an toàn: một lỗi lẻ ở bất kỳ đâu KHÔNG được làm sập cả bot (tránh "bot ngừng").
// Ghi log rồi tiếp tục chạy; mỗi update đã được bọc try/catch riêng, mọi ghi tiền đều trong transaction DB.
process.on('uncaughtException', e => { console.error('UNCAUGHT EXCEPTION:', (e && e.stack) || e); });
process.on('unhandledRejection', e => { console.error('UNHANDLED REJECTION:', (e && e.stack) || e); });

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// AI đọc ảnh bill: tương thích OpenAI / Grok (xAI) / bất kỳ API chuẩn chat-completions.
// OpenAI: để mặc định. Grok: AI_BASE_URL=https://api.x.ai/v1, AI_MODEL=grok-2-vision-1212, AI_API_KEY=xai-...
const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.GROK_API_KEY || '';
const AI_BASE_URL = String(process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || '');
// Super admins: SUPER_ADMIN_IDS (comma-separated) + SUPER_ADMIN_ID (singular) → Set of Telegram user ids.
// Preferred way to grant admin to user ids. ADMIN_CHAT_ID is kept for backward compat.
const SUPER_ADMIN_IDS = new Set(
  [...String(process.env.SUPER_ADMIN_IDS || '').split(','), String(process.env.SUPER_ADMIN_ID || '')]
    .map(x => x.trim()).filter(Boolean)
);
function isSuperAdmin(userId){ return SUPER_ADMIN_IDS.has(String(userId)); }
const LARGE_AMOUNT = (() => { try { return BigInt(process.env.BOT_LARGE_AMOUNT || '100000000'); } catch { return 100000000n; } })();
const BOT_TIMEZONE = process.env.BOT_TIMEZONE || 'Asia/Ho_Chi_Minh';
// Telegram web_app buttons require an https URL (else BUTTON_TYPE_INVALID). Unset/empty/http -> https default.
const WEBAPP_URL_DEFAULT = 'https://aech-bot-production.up.railway.app/mini/bank.html';
const WEBAPP_URL = (() => { let v = String(process.env.WEBAPP_URL || '').trim(); if (!v) return WEBAPP_URL_DEFAULT; v = v.replace(/^http:\/\//i, 'https://'); return /^https:\/\/[^\s]+$/i.test(v) ? v : WEBAPP_URL_DEFAULT; })();
// Mở Mini App từ nhóm: đính kèm chat_id của nhóm vào URL (mini/bank.html đọc từ query nếu initDataUnsafe thiếu chat).
function webAppUrlFor(chat){ if(!chat||chat.type==='private')return WEBAPP_URL; const u=new URL(WEBAPP_URL); u.searchParams.set('chat_id',String(chat.id)); return u.toString(); }
const TELEGRAM_API = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : '';
const MIME_TYPES = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};

const sessions = new routing.SessionMap();
const pendingNv = new Map(); // "chatId:adminUserId" -> {action:'grant'|'revoke', exp}
let shuttingDown = false;
let ready = false;
let botUserId = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fetchT(url,opts={},ms=30000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...opts,signal:c.signal});}finally{clearTimeout(t);}}
const sessionKey = (chatId,userId) => `${chatId}:${userId}`;
const actorFrom = from => ({id:String(from?.id||''),name:from?.username?`@${from.username}`:[from?.first_name,from?.last_name].filter(Boolean).join(' ')});
const inline = rows => ({inline_keyboard:rows});
const noteLine = a => a.label ? '\n📝 Ghi chú: ' + a.label : '';
const forceReply = () => ({force_reply:true,selective:true,input_field_placeholder:'Nhập dữ liệu'});

function mainKeyboard(){return{keyboard:[[{text:'💰 Tiền vào'},{text:'💸 Tiền ra'}],[{text:'🏦 Tạo QR'},{text:'📊 Tổng'}],[{text:'⚙️ Quản lý'}]],resize_keyboard:true,is_persistent:true,selective:true};}

async function telegram(method,body={}){
  if(!TELEGRAM_API)throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const ctrl=new AbortController();const ms=(Number(body.timeout)||0)*1000+20000;const t=setTimeout(()=>ctrl.abort(),ms);
  let response;try{response=await fetch(`${TELEGRAM_API}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:ctrl.signal});}finally{clearTimeout(t);}
  let data=null;try{data=await response.json();}catch{}
  if(!response.ok||data?.ok===false)throw new Error(`Telegram ${method} failed: ${response.status}${data?.description?` - ${data.description}`:''}`);
  return data;
}
const send=(chatId,text,extra={})=>telegram('sendMessage',{chat_id:chatId,text,...extra});
const editText=(chatId,messageId,text,extra={})=>telegram('editMessageText',{chat_id:chatId,message_id:messageId,text,...extra});
async function answerCallback(id,text=''){try{await telegram('answerCallbackQuery',{callback_query_id:id,text,show_alert:false});}catch{}}
async function clearButtons(chatId,messageId){try{await telegram('editMessageReplyMarkup',{chat_id:chatId,message_id:messageId,reply_markup:{inline_keyboard:[]}});}catch{}}

async function sendPhotoDataUrl(chatId,dataUrl,caption,replyMarkup,parseMode){
  const m=String(dataUrl||'').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  if(!m)throw new Error('Mã QR không hợp lệ.');
  const form=new FormData();form.append('chat_id',String(chatId));form.append('caption',caption);form.append('photo',new Blob([Buffer.from(m[2],'base64')],{type:m[1]}),'vietqr.png');
  if(parseMode)form.append('parse_mode',parseMode);
  if(replyMarkup)form.append('reply_markup',JSON.stringify(replyMarkup));
  const response=await fetchT(`${TELEGRAM_API}/sendPhoto`,{method:"POST",body:form},45000);let data=null;try{data=await response.json();}catch{}
  if(!response.ok||data?.ok===false)throw new Error(`Telegram sendPhoto failed: ${response.status}${data?.description?` - ${data.description}`:''}`);
  return data;
}
async function sendDocument(chatId,filename,buffer,caption='',mime='text/csv'){
  const form=new FormData();form.append('chat_id',String(chatId));if(caption)form.append('caption',caption);
  form.append('document',new Blob([buffer],{type:mime}),filename);
  const response=await fetchT(`${TELEGRAM_API}/sendDocument`,{method:"POST",body:form},45000);let data=null;try{data=await response.json();}catch{}
  if(!response.ok||data?.ok===false)throw new Error(`Telegram sendDocument failed: ${response.status}${data?.description?` - ${data.description}`:''}`);
  return data;
}

const _memberCache=new Map(); // "chatId:userId" -> {status,at}
async function chatMemberStatus(chatId,userId){
  const k=`${chatId}:${userId}`,now=Date.now(),c=_memberCache.get(k);
  if(c&&now-c.at<120000)return c.status;
  let status='member';
  try{const m=await telegram('getChatMember',{chat_id:chatId,user_id:userId});status=m?.result?.status||'member';}catch{status='member';}
  _memberCache.set(k,{status,at:now});return status;
}
// Dọn bộ nhớ định kỳ — tránh 2 Map phình mãi khiến bot "chạy 1 ngày rồi hết RAM".
const _MEMBER_TTL=120000, _MEMBER_CAP=5000, _SESSION_CAP=3000;
function cleanupMemory(){
  try{
    const now=Date.now();
    for(const [k,v] of _memberCache){ if(!v||now-v.at>_MEMBER_TTL) _memberCache.delete(k); }
    if(_memberCache.size>_MEMBER_CAP){ const drop=_memberCache.size-_MEMBER_CAP; let i=0; for(const k of _memberCache.keys()){ if(i++>=drop)break; _memberCache.delete(k); } }
    // Phiên thao tác bị bỏ dở (user bấm nút rồi không nhập) sẽ tồn mãi — giới hạn số lượng, xóa cũ nhất.
    if(sessions.size>_SESSION_CAP){ const drop=sessions.size-_SESSION_CAP; let i=0; for(const k of sessions.keys()){ if(i++>=drop)break; sessions.delete(k); } }
    const rss=Math.round(process.memoryUsage().rss/1048576);
    console.log(`[mem] rss=${rss}MB sessions=${sessions.size} members=${_memberCache.size}`);
  }catch(e){console.error('cleanupMemory error:',e.message);}
}
setInterval(cleanupMemory, 5*60*1000).unref();
async function getAccess(chat,from){
  if(!chat||!from)return'none';
  if(isSuperAdmin(from.id))return'admin';
  // Legacy: ADMIN_CHAT_ID still honored for backward compat. SUPER_ADMIN_IDS is preferred for user ids.
  if(ADMIN_CHAT_ID&&String(from.id)===ADMIN_CHAT_ID)return'admin';
  if(chat.type==='private')return'none';
  if(await storage.isManager(chat.id,from.id))return'manager';
  // Chủ nhóm / quản trị viên nhóm Telegram được tự động dùng bot (không cần /them_nv).
  const st=await chatMemberStatus(chat.id,from.id);
  if(st==='creator')return'admin';
  if(st==='administrator')return'manager';
  return'none';
}
async function ensureGroup(chat,from){return storage.ensureGroup(chat.id,chat?.title||actorFrom(from).name||'AECH',BOT_TIMEZONE);}
// Ghi nhận nhóm mỗi khi bot thấy tin trong nhóm hoặc được thêm/đổi quyền (my_chat_member).
async function registerGroupChat(chat){
  if(!groupsapi.isGroupChat(chat))return;
  try{await storage.upsertGroupTitle(chat.id,groupsapi.titleFor(chat),BOT_TIMEZONE);}
  catch(e){console.error('register group:',e.message);}
}
async function deny(chatId){await send(chatId,'⛔ Không có quyền.',{reply_markup:{remove_keyboard:true}});}
async function botIsGroupAdmin(chat){
  if(chat?.type==='private')return true;
  if(!botUserId){try{const me=await telegram('getMe');botUserId=String(me?.result?.id||'');}catch{return false;}}
  if(!botUserId)return false;
  try{const m=await telegram('getChatMember',{chat_id:chat.id,user_id:botUserId});return['creator','administrator'].includes(m?.result?.status);}catch{return false;}
}

async function aiChat(messages){
  if(!AI_API_KEY)throw new Error('AI chưa cấu hình (AI_API_KEY).');
  const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),30000);
  let response;try{response=await fetch(`${AI_BASE_URL}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${AI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:AI_MODEL,messages,temperature:0}),signal:ctrl.signal});}catch(e){if(e&&e.name==='AbortError')throw new Error('AI phản hồi quá chậm.');throw e;}finally{clearTimeout(t);}
  if(!response.ok)throw new Error(`AI HTTP ${response.status}`);
  const data=await response.json();
  return String(data?.choices?.[0]?.message?.content||'').trim();
}
function compact(v){return String(v||'').replace(/[\*_`]/g,'').replace(/\s+/g,' ').trim().toLowerCase();}
function exactSubstring(source,candidate){const c=compact(candidate);return Boolean(c&&compact(source).includes(c));}
async function extractPaymentWithAI(text){
  if(!AI_API_KEY||!text)return null;
  const raw=await aiChat([{role:'user',content:'Trích dữ liệu yêu cầu chuyển khoản. Không suy đoán, không sửa số, tên hay nội dung. Mỗi giá trị phải xuất hiện nguyên văn trong tin nhắn. Trả JSON duy nhất: {"bank":"","account":"","name":"","amount":"","content":"","note":""}. Không thấy rõ thì để rỗng.\n\n'+text}]);
  const a=raw.indexOf('{'),b=raw.lastIndexOf('}');if(a<0||b<=a)return null;let ai;try{ai=JSON.parse(raw.slice(a,b+1));}catch{return null;}const safe={};
  for(const k of['bank','name','content','note'])if(ai[k]&&exactSubstring(text,ai[k]))safe[k]=ai[k];
  if(ai.account){const digits=String(ai.account).replace(/\D/g,'');if(/^\d{6,19}$/.test(digits)&&String(text).replace(/\D/g,'').includes(digits))safe.account=digits;}
  if(ai.amount&&exactSubstring(text,ai.amount)){const amount=parseAmount(ai.amount);if(amount)safe.amount=amount;}
  return safe;
}
async function parsePaymentSafely(text,opts={}){let p={...parsePaymentText(text),aiUsed:false};if(paymentCompleteness(p).length&&AI_API_KEY&&opts.ai!==false){try{const ai=await extractPaymentWithAI(text);if(ai)p={...p,bank:p.bank||ai.bank||'',account:p.account||ai.account||null,name:p.name||ai.name||'',amount:p.amount||ai.amount||null,content:p.content||ai.content||'',note:p.note||ai.note||'',aiUsed:true};}catch(e){console.error('AI payment extraction error:',e.message);}}return p;}
function looksLikePaymentRequest(text){
  const s=String(text||'');
  // 1) Có từ khóa rõ ràng
  if(/(?:số\s*(?:tài\s*khoản|tk)|\bstk\b|ngân\s*hàng|\bbank\b|chủ\s*tài\s*khoản|số\s*tiền|nội\s*dung|\bnd\b|họ\s*và\s*tên|ho\s*va\s*ten)/i.test(s))return true;
  // 2) Tin tự do: chỉ cần có số TK (6-19 số) kèm ngân hàng HOẶC số tiền -> coi là yêu cầu thanh toán
  try{const p=parsePaymentText(s);if(p&&p.account&&(p.bank||p.amount))return true;}catch(e){}
  return false;
}

async function telegramImageData(message){let file=null;if(message.photo?.length)file=message.photo[message.photo.length-1];else if(message.document?.file_id&&String(message.document.mime_type||'').startsWith('image/'))file=message.document;if(!file?.file_id)return null;const info=await telegram('getFile',{file_id:file.file_id});const fp=info.result?.file_path;if(!fp)return null;const r=await fetchT(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fp}`,{},30000);if(!r.ok)throw new Error(`Download image failed: ${r.status}`);const bytes=Buffer.from(await r.arrayBuffer());return{dataUrl:`data:${message.document?.mime_type||'image/jpeg'};base64,${bytes.toString('base64')}`,fileUniqueId:file.file_unique_id||null};}
async function readPaymentImage(dataUrl){return aiChat([{role:'user',content:[{type:'text',text:'Đọc biên lai/màn hình chuyển khoản. Chỉ chép đúng những gì nhìn thấy, không suy đoán. Trả về đúng 5 dòng, mỗi dòng 1 nhãn (bỏ dòng nào không có):\nNgân hàng: <tên ngân hàng NHẬN tiền>\nChủ tài khoản: <tên người nhận>\nSố tài khoản: <chỉ chữ số>\nSố tiền: <chỉ con số>\nNội dung: <lời nhắn chuyển khoản, NGẮN GỌN, KHÔNG kèm ngày giờ, KHÔNG kèm mã giao dịch, KHÔNG kèm tên ngân hàng>\nKhông rõ trường nào thì bỏ qua dòng đó.'},{type:'image_url',image_url:{url:dataUrl}}]}]);}

// Đọc bill trả về JSON có cấu trúc — ổn định hơn, bắt đúng TÀI KHOẢN NGƯỜI NHẬN.
// Trả {bank,account,name,amount,content} (đã làm sạch) hoặc null.
function parseBillJson(raw){
  const a=String(raw||'').indexOf('{'),b=String(raw||'').lastIndexOf('}');
  if(a<0||b<=a)return null;
  let j;try{j=JSON.parse(String(raw).slice(a,b+1));}catch{return null;}
  const account=String(j.account||'').replace(/\D/g,'');
  const amount=parseAmount(String(j.amount??''));
  return {
    bank:String(j.bank||'').trim(),
    account:/^\d{6,19}$/.test(account)?account:null,
    name:String(j.name||'').replace(/\s+/g,' ').trim().slice(0,70),
    amount:amount||null,
    content:cleanContent(String(j.content||''))
  };
}
async function readBillAI(dataUrl){
  const raw=await aiChat([{role:'user',content:[
    {type:'text',text:'Đây là ảnh biên lai hoặc màn hình chuyển khoản ngân hàng Việt Nam. Hãy trích THÔNG TIN NGƯỜI NHẬN tiền (không phải người gửi). Chỉ dùng số và chữ nhìn thấy trong ảnh, tuyệt đối không bịa, không suy đoán. Bỏ qua số điện thoại, mã giao dịch, ngày giờ. Trả về DUY NHẤT một đối tượng JSON, không giải thích:\n{"bank":"tên ngân hàng nhận","account":"số tài khoản người nhận, chỉ chữ số","name":"tên chủ tài khoản nhận","amount":"số tiền, chỉ chữ số","content":"nội dung/lời nhắn chuyển khoản ngắn gọn"}\nTrường nào không chắc chắn thì để chuỗi rỗng "".'},
    {type:'image_url',image_url:{url:dataUrl}}
  ]}]);
  return parseBillJson(raw);
}
// Tên chủ TK KHÔNG nằm trong mã QR — đọc chữ tên hiển thị trên ảnh (nếu có AI).
async function readAccountNameAI(dataUrl){
  if(!AI_API_KEY)return '';
  try{
    const raw=await aiChat([{role:'user',content:[
      {type:'text',text:'Trong ảnh mã QR ngân hàng này, hãy chép CHÍNH XÁC tên chủ tài khoản (tên người hoặc tên công ty) in gần số tài khoản. CHỈ trả về đúng cái tên, không thêm bất kỳ chữ nào khác. Không thấy thì trả về rỗng.'},
      {type:'image_url',image_url:{url:dataUrl}}
    ]}]);
    return String(raw||'').replace(/[\r\n]+/g,' ').replace(/^["'`\s]+|["'`\s]+$/g,'').slice(0,70).trim();
  }catch(e){console.error('name OCR:',e.message);return '';}
}

function paymentButtons(p,isAdmin){const paid={text:'✅ Đã thanh toán',callback_data:`pay:paid:${p.rawId}:${p.version}`};if(!isAdmin)return inline([[paid]]);return inline([[paid,{text:'✏️ Sửa',callback_data:`pay:edit:${p.rawId}:${p.version}`},{text:'❌ Hủy',callback_data:`pay:cancel:${p.rawId}:${p.version}`}]]);}
function editButtons(p,originMessageId){return inline([[{text:'🏦 Bank',callback_data:`field:${p.rawId}:${p.version}:bank:${originMessageId}`},{text:'💳 STK',callback_data:`field:${p.rawId}:${p.version}:account:${originMessageId}`}],[{text:'👤 Tên',callback_data:`field:${p.rawId}:${p.version}:name:${originMessageId}`},{text:'💰 Số tiền',callback_data:`field:${p.rawId}:${p.version}:amount:${originMessageId}`}],[{text:'📝 Nội dung',callback_data:`field:${p.rawId}:${p.version}:content:${originMessageId}`}]]);}
function bigWarn(amount){try{return BigInt(amount)>=LARGE_AMOUNT?'⚠️ SỐ TIỀN LỚN — KIỂM TRA KỸ!\n':'';}catch{return '';}}
function paymentCaption(p){return `${bigWarn(p.amount)}🏦 ${p.bankName}\nSTK: ${p.account}${p.accountName?`\nChủ TK: ${p.accountName}`:''}\nSố tiền: ${money(p.amount)}\nNội dung: ${p.content}${p.note?`\nGhi chú: ${p.note}`:''}\n${p.id}`;}

async function preparePayment(parsed){
  const missing=paymentCompleteness(parsed);if(missing.length)throw new Error(`Thiếu: ${missing.join(', ')}.`);
  const bank=await vietqr.resolveBank(parsed.bank||parsed.raw);if(!bank)throw new Error('Không nhận ra ngân hàng. Ghi rõ tên hoặc BIN ngân hàng.');
  // Optional online name verification — never blocks QR creation.
  let verifiedName=null;
  try{verifiedName=await vietqr.lookupAccount(bank,parsed.account);}catch{verifiedName=null;}
  const finalName=verifiedName||parsed.name;
  const nameMismatch=Boolean(verifiedName)&&vietqr.normalizeAccountName(parsed.name)!==vietqr.normalizeAccountName(verifiedName);
  const qr=await vietqr.generateQr({bank,account:parsed.account,amount:parsed.amount,content:parsed.content});
  return{raw:parsed.raw||'',bankInput:parsed.bank,bankName:bank.shortName||bank.name||parsed.bank,bankCode:bank.code||'',bankBin:String(bank.bin||''),account:String(parsed.account),nameInput:parsed.name,verifiedName:finalName,nameMismatch,amount:BigInt(parsed.amount),content:qr.content,note:parsed.note||'',qr};
}
async function sendPaymentQr(chatId,request,qr,isAdmin){await sendPhotoDataUrl(chatId,qr.qrDataURL,paymentCaption(request),paymentButtons(request,isAdmin));}
async function finalizePayment(chat,from,parsed,sourceMessageId,sourceFileUniqueId=null){
  const actor=actorFrom(from);const isAdmin=(await getAccess(chat,from))==='admin';let prepared;
  try{prepared=await preparePayment(parsed);}catch(e){await send(chat.id,`⚠️ ${e.message}`);return null;}
  const request=await storage.createPaymentRequest(chat.id,actor,prepared,sourceMessageId,sourceFileUniqueId);
  if(request.status==='confirmed'){await send(chat.id,`✅ ${request.id} đã thanh toán.`);return request;}
  if(request.status==='cancelled'){await send(chat.id,`❌ ${request.id} đã hủy.`);return request;}
  let qr=prepared.qr;
  if(request.duplicate){const bank=await vietqr.resolveBank(request.bankName||request.bankRaw);qr=await vietqr.generateQr({bank,account:request.account,accountName:request.accountName,amount:request.amount,content:request.content});}
  await sendPaymentQr(chat.id,request,qr,isAdmin);return request;
}
async function createAndShowPayment(chat,from,text,sourceMessageId,sourceFileUniqueId=null){
  const parsed=await parsePaymentSafely(text);
  return finalizePayment(chat,from,parsed,sourceMessageId,sourceFileUniqueId);
}

function transactionConfirmButtons(type,amount,sourceMessageId){return inline([[{text:'✅ Xác nhận',callback_data:`tx:${type}:${amount}:${sourceMessageId}`},{text:'❌ Hủy',callback_data:'tx:cancel'}]]);}
async function showTransactionPreview(chat,type,amount,sourceMessageId){const g=await storage.getGroup(chat.id);if(type==='in'&&!g?.feeConfigured){await send(chat.id,'⚠️ Chưa cấu hình % phí.');return;}const warn=bigWarn(amount);if(type==='in'){const fee=calculateFee(amount,g.feeRatePpm);await send(chat.id,`${warn}💰 Tiền vào\nSố tiền: ${money(amount)}\nPhí (${formatFeeRatePercent(g.feeRatePpm)}): ${money(fee)}\nThực nhận: ${money(amount-fee)}`,{reply_markup:transactionConfirmButtons('in',amount.toString(),sourceMessageId)});}else await send(chat.id,`${warn}💸 Tiền ra\nSố tiền: ${money(amount)}`,{reply_markup:transactionConfirmButtons('out',amount.toString(),sourceMessageId)});}
async function transactionResult(tx){if(tx.type==='in')return`✅ Đã cộng tiền\nSố tiền: ${money(tx.gross)}\nPhí (${formatFeeRatePercent(tx.feeRatePpm)}): ${money(tx.fee)}\nCòn lại: ${money(tx.balance)}`;return`✅ Đã trừ tiền\nSố tiền: ${money(tx.gross)}\nCòn lại: ${money(tx.balance)}`;}
async function groupSummaryText(chatId){const g=await storage.getGroup(chatId),t=await storage.totals(chatId),d=await storage.dailySummary(chatId);return`📊 ${g?.name||'NHÓM'}\nPhí: ${g?.feeConfigured?formatFeeRatePercent(g.feeRatePpm):'chưa cấu hình'}\nBill vào: ${d.billInCount}\nTiền vào: ${money(d.grossIn)}\nPhí: ${money(d.fees)}\nThực nhận: ${money(d.netIn)}\nBill ra: ${d.billOutCount}\nTiền ra: ${money(d.outgoing)}\nCòn lại: ${money(t.balance)}`;}
function closeoutText(group,s,final=false){return`${final?'🧾 ĐÃ CHỐT SỔ':'🧾 XÁC NHẬN CHỐT SỔ'}\nNhóm: ${group?.name||''}\nNgày: ${s.date}\nBill vào: ${s.billInCount}\nTiền vào: ${money(s.grossIn)}\nPhí: ${money(s.fees)}\nThực nhận: ${money(s.netIn)}\nBill ra: ${s.billOutCount}\nTiền ra: ${money(s.outgoing)}\nĐầu ngày: ${money(s.openingBalance)}\nCuối ngày: ${money(s.closingBalance)}`;}

function fmtLocal(dt){try{const d=new Date(dt);const p=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;}catch{return String(dt);}}
async function buildStatementFile(chatId,from,to,label){
  const rows=await storage.statementRows(chatId,from,to);
  if(!rows.length)return null;
  const g=await storage.getGroup(chatId);
  const tz=g?.timezone||'Asia/Ho_Chi_Minh';
  const feeStr=g?.feeConfigured?formatFeeRatePercent(g.feeRatePpm):'chưa cấu hình';
  let nowStr='';try{nowStr=new Intl.DateTimeFormat('vi-VN',{timeZone:tz,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());}catch{nowStr=new Date().toISOString();}
  let grossIn=0n,fees=0n,netIn=0n,out=0n;
  const H=s=>({v:s,s:'h'});
  const data=[
    [{v:`SỔ QUỸ THU CHI — ${g?.name||'NHÓM'}`,s:'b'}],
    [{v:`Kỳ: ${label}`,s:'b'},'',{v:`% Phí: ${feeStr}`,s:'b'},'',{v:`Xuất lúc: ${nowStr}`,s:'b'}],
    [],
    [H('Mã GD'),H('Loại'),H('Số tiền'),H('Phí'),H('Thực nhận'),H('Nội dung'),H('Người'),H('Thời gian')]
  ];
  for(const t of rows){
    if(t.type==='in'){grossIn+=t.gross;fees+=t.fee;netIn+=t.net;}else out+=t.gross;
    data.push([t.id,{v:t.type==='in'?'Tiền vào':'Tiền ra',s:t.type==='in'?'g':'r'},{v:t.gross.toString(),n:true,s:'m'},{v:t.fee.toString(),n:true,s:'m'},{v:(t.type==='in'?t.net:t.gross).toString(),n:true,s:'m'},t.note,t.userName,fmtLocal(t.localTime)]);
  }
  const nIn=rows.filter(r=>r.type==='in').length,nOut=rows.filter(r=>r.type==='out').length;
  data.push([{v:'TỔNG',s:'b'},'',{v:grossIn.toString(),n:true,s:'mb'},{v:fees.toString(),n:true,s:'mb'},{v:(netIn-out).toString(),n:true,s:'mb'},{v:`Vào ${nIn} / Ra ${nOut}`,s:'b'},'','']);
  data.push([]);
  data.push([{v:'Số dư cuối kỳ:',s:'b'},'',{v:(netIn-out).toString(),n:true,s:'mb'}]);
  const cols=[14,9,14,12,14,26,10,16];
  const buffer=buildXlsx('Sao ke',data,cols);
  const fname=`saoke_${from}_${to}.xlsx`.replace(/[^\w.\-]/g,'_');
  const caption=`📄 Sao kê ${label}\nTiền vào: ${money(grossIn)} • Phí: ${money(fees)} • Thực nhận: ${money(netIn)}\nTiền ra: ${money(out)} • Chênh lệch: ${money(netIn-out)}`;
  return {buffer,fname,caption,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
}
async function handleStatement(chat,text){
  const args=text.replace(/^\/(saoke|export)(?:@\w+)?\s*/i,'').trim();
  const today=await storage.businessDate(chat.id);
  let from=today,to=today,label='hôm nay';
  const dates=args.match(/\d{4}-\d{2}-\d{2}/g);
  if(/^thang$|^month$/i.test(args)){from=today.slice(0,8)+'01';to=today;label='tháng này';}
  else if(dates&&dates.length>=2){from=dates[0];to=dates[1];label=`${from} → ${to}`;}
  else if(dates&&dates.length===1){from=dates[0];to=dates[0];label=from;}
  const file=await buildStatementFile(chat.id,from,to,label);
  if(!file){await send(chat.id,`📄 Không có giao dịch (${label}).`);return;}
  await sendDocument(chat.id,file.fname,file.buffer,file.caption,file.mime);
}

// ===== Thông báo thanh toán gửi khách =====
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
// Nội dung gọn, chuyên nghiệp. Số TK / số tiền / nội dung để <code> (chạm là sao chép) cho khách nhập tay.
function announceCaption({bankName,account,name,amount,content,variant}){
  const stop=variant==='stop';
  const L=[];
  if(stop)L.push('🚫 TẠM NGƯNG TÀI KHOẢN','⚠️ Vui lòng KHÔNG chuyển khoản vào tài khoản dưới đây:','');
  else L.push('💳 THÔNG TIN CHUYỂN KHOẢN','');
  if(bankName)L.push(`🏦 Ngân hàng: <b>${esc(bankName)}</b>`);
  if(account)L.push(`🔢 Số tài khoản: <code>${esc(account)}</code>`);
  if(name)L.push(`👤 Chủ tài khoản: ${esc(name)}`);
  if(!stop){
    if(amount)L.push(`💵 Số tiền: <code>${esc(String(amount))}</code> (${esc(money(amount))})`);
    else L.push('💵 Số tiền: Quý khách tự nhập');
    if(content)L.push(`📝 Nội dung: <code>${esc(content)}</code>`);
  }
  L.push('');
  if(stop)L.push('⚠️ Tài khoản này đang TẠM NGƯNG. Vui lòng chờ thông báo tài khoản mới. ⚠️');
  else L.push('Quét mã QR phía trên, hoặc chạm vào số để sao chép và nhập tay.');
  return L.join('\n');
}
async function sendBroadcast(fromChatId,targets,{photo,caption,textMsg}){
  let ok=0;
  for(const cid of targets){try{if(photo)await sendPhotoDataUrl(cid,photo,caption,undefined,'HTML');else await send(cid,textMsg);ok++;}catch(e){console.error('Broadcast send error:',cid,e.message);}}
  await send(fromChatId,`✅ Đã gửi thông báo tới ${ok}/${targets.length} nhóm.`);
}
// Admin gửi ẢNH QR trong lúc Thông báo: tự đọc info bank rồi gửi khách kèm nội dung.
async function handleBroadcastImage(message,st){
  const chat=message.chat,from=message.from,key=sessionKey(chat.id,from.id);
  if(await getAccess(chat,from)!=='admin'){sessions.delete(key);return;}
  sessions.delete(key);
  let image=null;try{image=await telegramImageData(message);}catch(e){console.error('BC image dl:',e.message);}
  if(!image){await send(chat.id,'⚠️ Không tải được ảnh. Gửi lại giúp mình.');return;}
  const targets=st.target==='all'?(await storage.listGroups()).map(g=>g.chatId):[st.target];
  const buf=dataUrlToBuffer(image.dataUrl);
  let qrText=null;try{qrText=buf?qrcore.decodeQrFromImage(buf):null;}catch(e){console.error('BC QR decode:',e.message);}
  const info=qrText?qrcore.parseVietQrPayload(qrText):null;
  if(!info){await sendBroadcast(chat.id,targets,{photo:image.dataUrl,caption:'💳 THÔNG TIN CHUYỂN KHOẢN\n\nVui lòng quét mã QR phía trên để chuyển khoản.'});return;}
  const bank=vietqr.resolveBank(info.bin);
  const name=await readAccountNameAI(image.dataUrl); // tên chủ TK đọc từ chữ trên ảnh
  // QR thông báo là QR TĨNH (khách tự nhập số tiền) — dựng lại từ ngân hàng + STK.
  let photo=image.dataUrl;
  try{if(bank){const qr=await vietqr.generateStaticQr({bank,account:info.account,content:info.content||''});photo=qr.qrDataURL;}}catch(e){console.error('BC static qr:',e.message);}
  const caption=announceCaption({bankName:bank?bank.shortName:info.bin,account:info.account,name,content:info.content||'',variant:st.variant});
  await sendBroadcast(chat.id,targets,{photo,caption});
}

async function staffListText(chat){
  const m=await storage.listManagers(chat.id);
  const head=m.length?('👥 NHÂN VIÊN:\n'+m.map((x,i)=>`${i+1}. ${x.userName||x.userId}`).join('\n')):'👥 Chưa có nhân viên.';
  return `${head}\n\n➕ Thêm: REPLY (trả lời) tin nhắn của người đó rồi gõ /them_nv\n➖ Xóa: REPLY tin của họ rồi gõ /xoa_nv\n\nNhân viên được: ghi tiền vào/ra, tạo QR, xem sổ, sao kê, chốt sổ.\nKhông được: sửa, xóa, hoàn giao dịch, cấu hình.`;
}
const staffButtons=()=>inline([[{text:'➕ Thêm',callback_data:'nv:add'},{text:'➖ Xóa',callback_data:'nv:del'}],[{text:'🔄 Làm mới',callback_data:'nv:refresh'}]]);
async function sendStaffList(chat){await send(chat.id,await staffListText(chat),{reply_markup:staffButtons()});}

const STAFF_SESSION_MS=3*60*1000;
async function resolveStaffTarget(chat,message,arg){
  const replyFrom=message?.reply_to_message?.from;
  if(replyFrom?.id&&!replyFrom.is_bot)return{target:{id:String(replyFrom.id)},tname:actorFrom(replyFrom).name,tuser:''};
  arg=String(arg||'').trim();
  if(/^\d+$/.test(arg))return{target:{id:arg},tname:'',tuser:''};
  if(/^@\w{3,}$/.test(arg)){
    const tuser=arg.slice(1);let resolved=null;
    try{const c=await telegram('getChat',{chat_id:arg});if(c?.result?.id&&c.result.type==='private')resolved=c.result;}catch{}
    if(!resolved)return{error:`⚠️ Không tra được ${arg}. Hãy REPLY tin của họ, hoặc gửi userId số.`};
    return{target:{id:String(resolved.id)},tname:'',tuser};
  }
  return{error:'⚠️ Hãy REPLY tin của người đó, hoặc gửi userId số, hoặc @username.'};
}
async function applyStaffChange(chat,actor,isAdd,r){
  const label=r.tuser?`@${r.tuser}`:(r.tname||r.target.id);
  if(isAdd){await storage.grantManager(chat.id,r.target.id,actor,r.tuser||r.tname);await send(chat.id,`✅ Đã thêm nhân viên: ${label}\nQuyền: ghi tiền vào/ra, tạo QR, xem sổ, sao kê, chốt sổ.\nKhông được: sửa, xóa, hoàn giao dịch hay cấu hình.`);}
  else{await storage.revokeManager(chat.id,r.target.id,actor);await send(chat.id,`✅ Đã xóa nhân viên: ${label}`);}
}

async function handleCallback(q){
  const chat=q.message?.chat,from=q.from;if(!chat||!from)return;const access=await getAccess(chat,from);if(access==='none'){await answerCallback(q.id,'Không có quyền.');return;}await ensureGroup(chat,from);const actor=actorFrom(from),data=String(q.data||'');
  try{
    if(data==='tx:cancel'){await answerCallback(q.id,'Đã hủy');if(q.message.text)await editText(chat.id,q.message.message_id,'❌ Đã hủy.');else await clearButtons(chat.id,q.message.message_id);return;}
    if(data.startsWith('tx:')){const[,type,amountText,sourceMessageId]=data.split(':');const amount=BigInt(amountText),g=await storage.getGroup(chat.id);let fee=0n,rate=0n;if(type==='in'){if(!g?.feeConfigured)throw new Error('Chưa cấu hình phí.');rate=g.feeRatePpm;fee=calculateFee(amount,rate);}const tx=await storage.addTransaction(chat.id,actor,type,amount,fee,rate,'',Number(sourceMessageId));await answerCallback(q.id,tx.duplicate?'Đã xử lý trước đó.':'Đã lưu.');await editText(chat.id,q.message.message_id,await transactionResult(tx),{reply_markup:{inline_keyboard:[]}});return;}
    if(data.startsWith('close:')){const date=data.slice(6),g=await storage.getGroup(chat.id),summary=await storage.dailySummary(chat.id,date),r=await storage.saveDailyCloseout(chat.id,actor,summary);await answerCallback(q.id,r.already?'Đã chốt trước đó.':'Đã chốt.');await editText(chat.id,q.message.message_id,`${r.already?'ℹ️ ĐÃ CHỐT TRƯỚC ĐÓ':'✅ ĐÃ CHỐT'}\n${closeoutText(g,r.summary,true)}`,{reply_markup:{inline_keyboard:[]}});try{const file=await buildStatementFile(chat.id,date,date,date);if(file)await sendDocument(chat.id,file.fname,file.buffer,file.caption,file.mime);}catch(e){console.error('Closeout report error:',e.message);}return;}
    if(data.startsWith('field:')){if(access!=='admin'){await answerCallback(q.id,'⛔ Chỉ Admin được sửa.');return;}const[,rawId,version,field,originMessageId]=data.split(':');const request=await storage.getPaymentRequest(chat.id,rawId);if(!request||request.status!=='pending'||request.version!==Number(version))throw new Error('Yêu cầu đã thay đổi.');sessions.set(sessionKey(chat.id,from.id),{mode:'edit_payment',rawId,version:Number(version),field,originMessageId:Number(originMessageId)});const labels={bank:'Ngân hàng',account:'STK',name:'Tên chủ TK',amount:'Số tiền',content:'Nội dung'};await answerCallback(q.id);await send(chat.id,`✏️ Nhập ${labels[field]}.`,{reply_markup:forceReply()});return;}
    if(data.startsWith('nv:')){
      if(access!=='admin'){await answerCallback(q.id,'⛔ Chỉ Admin chính.');return;}
      const act=data.slice(3);
      if(act==='add'||act==='del'){
        const isAdd=act==='add';
        pendingNv.set(`${chat.id}:${from.id}`,{action:isAdd?'grant':'revoke',exp:Date.now()+180000});
        sessions.set(sessionKey(chat.id,from.id),{mode:isAdd?'staff_add':'staff_del',at:Date.now()});
        await answerCallback(q.id);
        await send(chat.id,`${isAdd?'➕ Thêm nhân viên':'➖ Xóa nhân viên'}: REPLY tin của người đó, hoặc gửi userId số, hoặc @username.\n⏳ Hiệu lực 3 phút. /cancel để hủy.`,{reply_markup:forceReply()});
        return;
      }
      if(act==='refresh'){await answerCallback(q.id);await sendStaffList(chat);return;}
      await answerCallback(q.id);return;
    }
    if(data.startsWith('mng:')){
      const act=data.slice(4);
      await answerCallback(q.id);
      if(act==='chotso'){const s=await storage.dailySummary(chat.id),g=await storage.getGroup(chat.id);await send(chat.id,closeoutText(g,s,false),{reply_markup:inline([[{text:'✅ Xác nhận chốt',callback_data:`close:${s.date}`},{text:'❌ Hủy',callback_data:'tx:cancel'}]])});return;}
      if(act==='saoke'){await handleStatement(chat,'/saoke');return;}
      if(act==='stk'){const accts=await storage.listReceivingAccounts(chat.id);if(!accts.length){await send(chat.id,access==='admin'?'🏦 Chưa có STK nhận. Thêm: /them_stk Ngân hàng | Số TK | Tên chủ TK | ghi chú':'🏦 Chưa có STK nhận.');return;}await send(chat.id,'🏦 STK nhận:\n'+accts.map(a=>`#${a.id} • ${a.bankName} • ${a.accountNo} • ${a.accountName}${noteLine(a)}`).join('\n')+(access==='admin'?'\nThêm: /them_stk · Xóa: /xoa_stk <số>':''));return;}
      if(act==='list'){const rows=await storage.listTransactions(chat.id,10);if(!rows.length){await send(chat.id,'📒 Chưa có giao dịch.');return;}await send(chat.id,rows.map(t=>t.type==='in'?`🟢 ${t.id} +${money(t.gross)} • phí ${money(t.fee)}`:`🔴 ${t.id} -${money(t.gross)}`).join('\n'));return;}
      if(act==='thongbao'){if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}const groups=await storage.listGroups();if(!groups.length){await send(chat.id,'Chưa có nhóm nào.');return;}const r=[[{text:`📣 Tất cả (${groups.length} nhóm)`,callback_data:'bc:all'}]];for(const g of groups)r.push([{text:g.name,callback_data:`bc:${g.chatId}`}]);await send(chat.id,'📢 Chọn nơi gửi thông báo:',{reply_markup:inline(r)});return;}
      if(act==='backup'){if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}const today=await storage.businessDate(chat.id);const file=await buildStatementFile(chat.id,'2000-01-01',today,'toàn bộ');if(!file){await send(chat.id,'Chưa có giao dịch để backup.');return;}await sendDocument(chat.id,`backup_${chat.id}_${today}.xlsx`,file.buffer,'💾 Backup toàn bộ giao dịch',file.mime);return;}
      if(act==='setup'){if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}sessions.set(sessionKey(chat.id,from.id),{mode:'setup_name'});await send(chat.id,'🛠️ CẤU HÌNH NHANH\nBước 1/3 — Nhập TÊN NHÓM:',{reply_markup:forceReply()});return;}
      if(act==='nhanvien'){if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}await sendStaffList(chat);return;}
      return;
    }
    if(data.startsWith('bc:')){
      if(access!=='admin'){await answerCallback(q.id,'Chỉ Admin chính.');return;}
      const target=data.slice(3);
      let label='nhóm đã chọn';
      if(target==='all'){const gs=await storage.listGroups();label=`TẤT CẢ ${gs.length} nhóm`;}
      else{const g=(await storage.listGroups()).find(x=>x.chatId===target);label=g?g.name:'nhóm đã chọn';}
      await answerCallback(q.id);
      await send(chat.id,`📢 Gửi tới: ${label}\nChọn loại thông báo:`,{reply_markup:inline([[{text:'💳 Báo NHẬN tiền',callback_data:`bcv:pay:${target}`}],[{text:'🚫 Báo NGƯNG tài khoản',callback_data:`bcv:stop:${target}`}]])});
      return;
    }
    if(data.startsWith('bcv:')){
      if(access!=='admin'){await answerCallback(q.id,'Chỉ Admin chính.');return;}
      const[,variant,target]=data.split(':');
      sessions.set(sessionKey(chat.id,from.id),{mode:'broadcast',target,variant});
      await answerCallback(q.id);
      const head=variant==='stop'?'🚫 BÁO NGƯNG tài khoản — gửi tài khoản cần ngưng:':'💳 BÁO NHẬN tiền — gửi tài khoản nhận:';
      await send(chat.id,`${head}\n• GỬI ẢNH QR ngân hàng → bot tự đọc, kèm nội dung${variant==='stop'?' cảnh báo':''}.\n• Hoặc dán: Ngân hàng | STK | Tên chủ TK.\n• Hoặc gõ lời nhắn thường.`,{reply_markup:forceReply()});
      return;
    }
    if(data.startsWith('imgtx:')){const[,type,amt,mid]=data.split(':');await answerCallback(q.id);try{await showTransactionPreview(chat,type,BigInt(amt),Number(mid));}catch(e){await send(chat.id,`⚠️ ${e.message}`);}return;}
    if(data==='imgqr'){const st=sessions.get(sessionKey(chat.id,from.id));await answerCallback(q.id);if(!st||st.mode!=='imgpay'){await send(chat.id,'⚠️ Hết hạn, gửi lại ảnh.');return;}sessions.delete(sessionKey(chat.id,from.id));const p={...st.parsed};if(!p.content)p.content='THANH TOAN';await finalizePayment(chat,from,p,st.msgId);return;}
    if(data.startsWith('preset:')){
      const pid=data.slice(7);
      if(pid==='manual'){sessions.set(sessionKey(chat.id,from.id),{mode:'payment'});await answerCallback(q.id);await send(chat.id,'🏦 Gửi thông tin thanh toán.',{reply_markup:forceReply()});return;}
      const acct=await storage.getReceivingAccount(chat.id,pid);
      if(!acct)throw new Error('Tài khoản không còn trong danh sách.');
      sessions.set(sessionKey(chat.id,from.id),{mode:'preset_amount',presetId:pid});
      await answerCallback(q.id);
      await send(chat.id,`🏦 ${acct.bankName} • ${acct.accountNo}\n👤 ${acct.accountName}\n💰 Nhập số tiền:`,{reply_markup:forceReply()});
      return;
    }
    if(!data.startsWith('pay:'))return;const[,action,rawId,versionText]=data.split(':');const version=Number(versionText||0),request=await storage.getPaymentRequest(chat.id,rawId);if(!request)throw new Error('Không tìm thấy yêu cầu.');
    if(action==='qr'||action==='stage'||action==='confirm'||action==='back')throw new Error('Yêu cầu cũ. Hãy gửi lại thông tin để tạo QR mới.');
    if(action==='cancel'){if(access!=='admin'){await answerCallback(q.id,'⛔ Chỉ Admin được hủy.');return;}const r=await storage.cancelPaymentRequest(chat.id,rawId,version,actor);await answerCallback(q.id,r.already?'Đã hủy trước đó.':'Đã hủy.');await clearButtons(chat.id,q.message.message_id);await send(chat.id,`❌ Đã hủy ${request.id}.`);return;}
    if(action==='edit'){if(access!=='admin'){await answerCallback(q.id,'⛔ Chỉ Admin được sửa.');return;}if(request.status!=='pending'||request.version!==version)throw new Error('Yêu cầu đã thay đổi.');await answerCallback(q.id);await send(chat.id,`✏️ ${request.id}`,{reply_markup:editButtons(request,q.message.message_id)});return;}
    if(action==='paid'){await answerCallback(q.id,'Đang xử lý...');const r=await storage.confirmPaymentRequest(chat.id,rawId,version,actor);await clearButtons(chat.id,q.message.message_id);await send(chat.id,r.already?'✅ Giao dịch này đã được xử lý.':`✅ Đã thanh toán\nSố tiền: ${money(r.request.amount)}\nCòn lại: ${money(r.balance)}`);return;}
  }catch(e){console.error('Callback error:',e.message);await answerCallback(q.id,e.message.slice(0,180));}
}

function dataUrlToBuffer(dataUrl){const m=String(dataUrl||'').match(/^data:[^;]+;base64,(.+)$/s);return m?Buffer.from(m[1],'base64'):null;}

// Try to read a VietQR directly from an uploaded image. Returns true if handled.
// Dọn nội dung đọc từ bill: bỏ ngày giờ, mã giao dịch dài, tên ngân hàng lẫn vào.
function cleanContent(s){
  let t=String(s||'').split(/\r?\n/)[0];
  t=t.replace(/\b\d{1,2}[\/.\- ]\d{1,2}[\/.\- ]\d{2,4}\b.*/,'');
  t=t.replace(/\b\d{1,2}:\d{2}\b.*/,'');
  t=t.replace(/\b[A-Z0-9]{9,}\b.*/,'');
  t=t.replace(/\b(sacombank|vietcombank|vietinbank|techcombank|mbbank|mb bank|bidv|agribank|acb|vpbank|tpbank|ngan hang)\b.*/i,'');
  return t.replace(/\s+/g,' ').trim().replace(/[;,|.\-]+$/,'').trim().slice(0,50).trim();
}
// After reading an image, show the extracted info and let the user choose what to do.
async function showImageChoice(chat,from,parsed,msgId){
  parsed={...parsed,content:cleanContent(parsed.content)};
  sessions.set(sessionKey(chat.id,from.id),{mode:'imgpay',parsed,msgId});
  const bank=await vietqr.resolveBank(parsed.bank||'');
  const line='━━━━━━━━━━━━━';
  const L=['🧾 ĐÃ ĐỌC TỪ ẢNH',line,`🏦 Ngân hàng:  ${bank?bank.shortName:(parsed.bank||'—')}`,`💳 Số TK:  ${parsed.account||'—'}`];
  if(parsed.name)L.push(`👤 Chủ TK:  ${parsed.name}`);
  if(parsed.amount)L.push(`💵 Số tiền:  ${money(parsed.amount)}`);
  if(parsed.content)L.push(`📝 Nội dung:  ${parsed.content}`);
  L.push(line);
  if(parsed.source==='ocr')L.push('⚠️ Số đọc từ ảnh có thể sai — KIỂM TRA kỹ số TK & số tiền trước khi dùng.');
  L.push('👉 Chọn thao tác:');
  const btns=[];
  if(parsed.amount)btns.push([{text:'💰 Ghi tiền vào',callback_data:`imgtx:in:${parsed.amount}:${msgId}`},{text:'💸 Ghi tiền ra',callback_data:`imgtx:out:${parsed.amount}:${msgId}`}]);
  btns.push([{text:'🏦 Tạo QR chuyển',callback_data:'imgqr'}]);
  await send(chat.id,L.join('\n'),{reply_markup:inline(btns)});
}

async function tryReadQrImage(chat,from,image,sourceMessageId){
  const buf=dataUrlToBuffer(image.dataUrl);
  if(!buf)return false;
  let qrText=null;
  try{qrText=qrcore.decodeQrFromImage(buf);}catch(e){console.error('QR decode error:',e.message);}
  if(!qrText)return false;
  const info=qrcore.parseVietQrPayload(qrText);
  if(!info){await send(chat.id,`🔎 Mã QR đọc được:\n${qrText.slice(0,300)}`);return true;}
  const name=await readAccountNameAI(image.dataUrl); // tên không có trong QR → đọc từ ảnh
  const parsed={bank:info.bin,account:info.account,amount:info.amount?BigInt(info.amount):null,content:info.content||'',name,source:'qr'};
  if(parsed.amount){await showImageChoice(chat,from,parsed,sourceMessageId);}
  else{const bank=vietqr.resolveBank(info.bin);const L=['🔎 Đọc được VietQR:',`🏦 ${bank?bank.shortName:info.bin}`,`STK: ${info.account}`];if(name)L.push(`Chủ TK: ${name}`);if(info.content)L.push(`Nội dung: ${info.content}`);await send(chat.id,L.join('\n'));}
  return true;
}

async function handleImage(message){
  const chat=message.chat,from=message.from;if(await getAccess(chat,from)==='none')return;await ensureGroup(chat,from);
  let image=null;
  try{image=await telegramImageData(message);}catch(e){console.error('Image download error:',e.message);}
  if(!image){await send(chat.id,'⚠️ Không tải được ảnh.');return;}
  // 1) A QR in the image is read locally, no API needed — always stable.
  try{if(await tryReadQrImage(chat,from,image,message.message_id))return;}catch(e){console.error('QR image error:',e.message);}
  // 2) No QR in the image.
  if(!AI_API_KEY){
    await send(chat.id,'🔎 Ảnh không có mã QR. Gửi ảnh có QR, hoặc dán chữ: MB 9704229999 500k nd COC PHONG');
    return;
  }
  try{
    // Ưu tiên đọc JSON có cấu trúc (ổn định, bắt đúng tài khoản người nhận).
    let parsed=null;
    try{parsed=await readBillAI(image.dataUrl);}catch(e){console.error('Bill JSON error:',e.message);}
    // Dự phòng: đọc dạng text rồi tách lại.
    if(!parsed||!parsed.account||!parsed.amount){
      const ocr=await readPaymentImage(image.dataUrl);const cleaned=ocr.replace(/:\s*KHÔNG RÕ/gi,': ');
      const p=await parsePaymentSafely(cleaned);
      parsed={bank:p.bank,account:p.account,amount:p.amount,content:p.content,name:p.name};
    }
    if(!parsed.account||!parsed.amount){const miss=[];if(!parsed.account)miss.push('số tài khoản');if(!parsed.amount)miss.push('số tiền');await send(chat.id,`⚠️ Ảnh thiếu: ${miss.join(', ')}. Gửi ảnh rõ hơn hoặc gõ tay.`);return;}
    await showImageChoice(chat,from,{bank:parsed.bank,account:parsed.account,amount:parsed.amount,content:parsed.content,name:parsed.name,source:'ocr'},message.message_id);
  }catch(e){
    console.error('OCR error:',e.message);
    const m=String(e.message||'');
    let why='';
    if(/HTTP 401|invalid_api_key|incorrect api key/i.test(m)) why=' (key chưa đúng — kiểm tra AI_API_KEY)';
    else if(/HTTP 429|quota|insufficient/i.test(m)) why=' (hết hạn mức/credit OpenAI)';
    else if(/HTTP 404|model/i.test(m)) why=' (sai tên model)';
    await send(chat.id,`⚠️ Không đọc được ảnh${why}. Gửi ảnh có QR hoặc gõ tay.`);
  }
}

// /bank /stkqr /thongtin_stk trong nhóm: ai cũng xem được. Gửi QR + thông tin từng STK.
async function handleStkInfo(chat){
  try{
    const accts=await storage.listReceivingAccounts(chat.id);
    if(!accts.length){await send(chat.id,'🏦 Chưa gắn STK. Admin dùng Mini App Gắn bank hoặc /them_stk');return;}
    const {shown,hidden}=stkinfo.splitForCommand(accts);
    for(const a of shown){
      const caption=stkinfo.stkCaption(a);
      let sent=false;
      try{
        if(a.hasQrImage){
          const img=await storage.getReceivingQrImage(chat.id,a.id);
          if(img){await sendPhotoDataUrl(chat.id,`data:${img.mime};base64,${img.b64}`,caption);sent=true;}
        }
        if(!sent){
          const bank=await vietqr.resolveBank(a.bankBin);
          const qr=await vietqr.generateStaticQr({bank,account:a.accountNo,content:''});
          await sendPhotoDataUrl(chat.id,qr.qrDataURL,caption);
          sent=true;
        }
      }catch(e){console.error('stk info qr:',e.message);}
      if(!sent)await send(chat.id,caption);
    }
    if(hidden)await send(chat.id,`… còn ${hidden} STK khác chưa hiển thị.`);
  }catch(e){console.error('stk info:',e.message);await send(chat.id,`⚠️ ${e.message}`);}
}

function isReplyToBot(message){
  const r=message&&message.reply_to_message;
  if(!r||!r.from)return false;
  if(botUserId&&String(r.from.id)===String(botUserId))return true;
  return !!r.from.is_bot;
}
async function handleMessage(message){
  const chat=message.chat,from=message.from;if(!chat||!from)return;if(chat.type!=='private')await registerGroupChat(chat);const text=String(message.text||'').trim();
  const isPrivate=chat.type==='private';
  if(message.photo||message.document){
    // Groups: ignore media payment/command flows unless caption is a slash command
    // or the user is clearly replying to a bot force_reply prompt (e.g. broadcast image).
    if(!isPrivate){
      const cap=String(message.caption||'').trim();
      const slashCap=routing.isSlashCommand(cap, message.caption_entities);
      if(!slashCap&&!isReplyToBot(message)){
        const sk=sessionKey(chat.id,from.id);
        if(sessions.has(sk))sessions.delete(sk);
        return;
      }
    }
    const st0=sessions.get(sessionKey(chat.id,from.id));
    if(st0&&st0.mode==='broadcast'){await handleBroadcastImage(message,st0);return;}
    await handleImage(message);return;
  }
  if(chat.type!=='private'&&stkinfo.isStkInfoCommand(text)){await handleStkInfo(chat);return;}
  // HARD RULE: groups only process slash commands (prefer bot_command entity at offset 0).
  // MENU_LABELS / sessions / pendingNv must NOT bypass silence in non-private chats.
  const isSlash=routing.isSlashCommand(text, message.entities);
  const isControl=isPrivate&&routing.isCommandText(text);
  const access=await getAccess(chat,from);
  // Người không có quyền: không xử lý gì, không hiện nút, không bấm được (im lặng).
  if(access==='none'){return;}
  // Pending nv:add / nv:del — private chats only. Groups: ignore free-text pending consumption.
  const nvKey=`${chat.id}:${from.id}`;
  const pend=pendingNv.get(nvKey);
  if(pend){
    if(Date.now()>pend.exp){pendingNv.delete(nvKey);}
    else if(!isPrivate){
      // In groups only honor explicit slash cancel; never swallow free text as staff target.
      if(text==='/cancel'||text==='/huy'){pendingNv.delete(nvKey);await send(chat.id,'✅ Đã hủy thao tác nhân viên.');return;}
      if(isSlash)pendingNv.delete(nvKey);
      // else: leave pending untouched but do not consume; fall through to hard gate
    }
    else if(text==='/cancel'||text==='/huy'){pendingNv.delete(nvKey);await send(chat.id,'✅ Đã hủy thao tác nhân viên.');return;}
    else if(isSlash){pendingNv.delete(nvKey);}
    else{
      if(access!=='admin'){pendingNv.delete(nvKey);await send(chat.id,'⛔ Chỉ Admin chính.');return;}
      const r=await resolveStaffTarget(chat,message,text);
      if(r.error){await send(chat.id,`${r.error}\n⏳ Còn hiệu lực trong 3 phút. Gửi lại hoặc /cancel.`);return;}
      pendingNv.delete(nvKey);
      const st=sessions.get(sessionKey(chat.id,from.id));
      if(st&&(st.mode==='staff_add'||st.mode==='staff_del'))sessions.delete(sessionKey(chat.id,from.id));
      try{await applyStaffChange(chat,actorFrom(from),pend.action==='grant',r);}
      catch(e){console.error('Pending nv error:',e.message);await send(chat.id,`⚠️ Lỗi cập nhật nhân viên: ${String(e.message||e).slice(0,160)}`);}
      return;
    }
  }
  // Nhóm: ONLY slash. No MENU_LABELS (isControl), no leftover sessions bypass.
  // Optional: allow free text only when clearly replying to the bot (force_reply continuation).
  if(!isPrivate&&!isSlash){
    if(!isReplyToBot(message)){
      const sk=sessionKey(chat.id,from.id);
      if(sessions.has(sk))sessions.delete(sk);
      return;
    }
    // Reply-to-bot free text: only continue an active session; otherwise silence.
    if(!sessions.has(sessionKey(chat.id,from.id)))return;
  }
  // Tin tự do: chỉ coi là yêu cầu thanh toán khi có số TK + (ngân hàng hoặc số tiền). Không gọi AI ở đây.
  if(isPrivate&&text&&!isControl&&!sessions.has(sessionKey(chat.id,from.id))&&routing.isClearPaymentRequest(text,parsePaymentText(text))){
    await ensureGroup(chat,from);const parsed=await parsePaymentSafely(text,{ai:false});const missing=paymentCompleteness(parsed);
    if(!missing.length){await createAndShowPayment(chat,from,text,message.message_id);return;}
    // Đọc được một phần -> LƯU lại, chỉ hỏi phần còn thiếu, KHÔNG bắt gõ/copy lại từ đầu.
    const kk=sessionKey(chat.id,from.id);
    sessions.set(kk,{mode:'complete_payment',p:{bank:parsed.bank||'',account:parsed.account||null,name:parsed.name||'',amount:parsed.amount?parsed.amount.toString():null,content:parsed.content||'',note:parsed.note||'',raw:parsed.raw||text},missing});
    const readLines=[parsed.bank&&`🏦 ${parsed.bank}`,parsed.account&&`#️⃣ ${parsed.account}`,parsed.amount&&`💵 ${money(parsed.amount)}`,parsed.content&&`📝 ${parsed.content}`].filter(Boolean).join('\n')||'(chưa rõ)';
    await send(chat.id,`🧾 Đã đọc được:\n${readLines}\n\n⚠️ Còn thiếu: ${missing.join(', ')}.\n👉 Nhập giúp "${missing[0]}":`,{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});
    return;
  }
  const group=await ensureGroup(chat,from),actor=actorFrom(from),key=sessionKey(chat.id,from.id);let state=sessions.get(key);
  // Chống "nhầm lệnh": khi đang chờ nhập (ghi tiền, tạo QR, thông báo...) mà người dùng
  // bấm nút menu hoặc gõ lệnh / khác -> hủy thao tác đang chờ để chạy đúng lệnh mới.
  if(isControl&&state){sessions.delete(key);state=undefined;}
  if(state&&(state.mode==='staff_add'||state.mode==='staff_del')){
    if(Date.now()-state.at>STAFF_SESSION_MS){sessions.delete(key);state=undefined;}
    else{
      if(access!=='admin'){sessions.delete(key);await send(chat.id,'⛔ Chỉ Admin chính.');return;}
      const r=await resolveStaffTarget(chat,message,text);
      if(r.error){await send(chat.id,`${r.error}\n⏳ Còn hiệu lực trong 3 phút. Gửi lại hoặc /cancel.`);return;}
      sessions.delete(key);
      await applyStaffChange(chat,actor,state.mode==='staff_add',r);
      return;
    }
  }

  if(text==='/start'||text==='/help'){
    const warning=chat.type!=='private'&&!await botIsGroupAdmin(chat)?'\n⚠️ Thêm bot làm Quản trị để tự đọc tin khách.':'';
    const guide=text==='/help'?'\n\n📖 Hướng dẫn:\n• 💰/💸: ghi tiền vào/ra (nhập số, hỗ trợ 500k, 1tr2, phép tính 500k*3).\n• 🏦 Tạo QR: chọn STK nhận rồi nhập số tiền + nội dung, hoặc gửi/paste thông tin khách.\n• 📊 Tổng: xem nhanh thu/chi/số dư.\n• ⚙️ Quản lý: Chốt sổ, Sao kê, STK nhận, Lịch sử, Nhân viên, Thông báo, Backup.\n• Gửi ảnh có mã QR: bot đọc ra thông tin.\n\n👥 Thêm nhân viên (admin): REPLY tin của người đó rồi gõ /them_nv, hoặc /them_nv <userId số> hoặc /them_nv @username — họ được ghi tiền/tạo QR/xem, KHÔNG sửa/xóa.\n➖ Xóa: /xoa_nv (reply) hoặc /xoa_nv <userId | @username>.\n⚙️ Admin (lệnh nhanh): /setgroup /setfee /them_nv /xoa_nv /nhanvien /them_stk /huygd /group':'';
    await send(chat.id,`AECH • ${group.name||chat.title||''}\nPhí: ${group.feeConfigured?formatFeeRatePercent(group.feeRatePpm):'chưa cấu hình'}\nSố dư: ${money(await storage.getBalance(chat.id))}${warning}${guide}`,{reply_markup:mainKeyboard(),reply_parameters:{message_id:message.message_id}});return;
  }
  if(text==='/cancel'||text==='/huy'){sessions.delete(key);await send(chat.id,'✅ Đã thoát thao tác đang chờ.',{reply_markup:mainKeyboard()});return;}
  if(/^\/(?:setgroup|setupgroup)(?:@\w+)?(?:\s|$)/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    const spec=text.replace(/^\/(?:setgroup|setupgroup)(?:@\w+)?\s*/i,'').trim();
    if(!spec){await send(chat.id,'⚠️ Nhập: /setgroup Tên nhóm | % phí');return;}
    const parts=spec.split('|').map(v=>v.trim());const name=parts[0];
    if(!name){await send(chat.id,'⚠️ Thiếu tên nhóm.');return;}
    let g=await storage.setGroupName(chat.id,name,actor);
    if(parts.length>1&&parts[1]!==''){
      const rate=parseFeeRatePercent(parts[1]);if(rate===null){await send(chat.id,'⚠️ % phí không hợp lệ.');return;}
      g=await storage.setFeeRate(chat.id,rate,actor);
    }
    await send(chat.id,`✅ ${g.name}\nPhí: ${g.feeConfigured?formatFeeRatePercent(g.feeRatePpm):'chưa cấu hình'}`);return;
  }
  if(text.startsWith('/setfee')){if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}const rate=parseFeeRatePercent(text.replace(/^\/setfee(?:@\w+)?\s*/i,'').trim());if(rate===null){await send(chat.id,'⚠️ % phí không hợp lệ.');return;}const g=await storage.setFeeRate(chat.id,rate,actor);await send(chat.id,`✅ Phí: ${formatFeeRatePercent(g.feeRatePpm)}`);return;}
  const staffCmd=text.match(/^\/(grant|them_nv|themnv|add_nv|revoke|xoa_nv|xoanv|remove_nv)(?:@\w+)?(?:\s+(\S+))?\s*$/i);
  if(staffCmd){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    const isAdd=/grant|them|add/i.test(staffCmd[1]);
    const r=await resolveStaffTarget(chat,message,(staffCmd[2]||'').trim());
    if(r.error){await send(chat.id,`${r.error}`);return;}
    await applyStaffChange(chat,actor,isAdd,r);
    return;
  }

  if(/^\/(nhanvien|nv|staff)(?:@\w+)?$/i.test(text)){const m=await storage.listManagers(chat.id);if(!m.length){await send(chat.id,'👥 Chưa có nhân viên.\nThêm: REPLY tin của người đó rồi gõ /them_nv');return;}await send(chat.id,'👥 NHÂN VIÊN:\n'+m.map((x,i)=>`${i+1}. ${x.userName||x.userId}`).join('\n')+'\n\nThêm: reply tin của họ + /them_nv\nXóa: reply tin của họ + /xoa_nv');return;}
  if(text==='/group'){const g=await storage.getGroup(chat.id),m=await storage.listManagers(chat.id),accts=await storage.listReceivingAccounts(chat.id);await send(chat.id,`⚙️ ${g.name}\nPhí: ${g.feeConfigured?formatFeeRatePercent(g.feeRatePpm):'chưa cấu hình'}\nSố dư: ${money(await storage.getBalance(chat.id))}\nQuản trị được cấp: ${m.length}\nSTK nhận: ${accts.length}\n\nLệnh: /stk /them_stk /xoa_stk /saoke /huygd`);return;}
  if(/^\/(saoke|export)(?:@\w+)?(\s|$)/i.test(text)){await handleStatement(chat,text);return;}
  if(/^\/baocao(?:@\w+)?(\s|$)/i.test(text)){await send(chat.id,await groupSummaryText(chat.id));const d=await storage.businessDate(chat.id);const file=await buildStatementFile(chat.id,d,d,'hôm nay');if(file)await sendDocument(chat.id,file.fname,file.buffer,file.caption,file.mime);return;}
  if(/^\/stk(?:@\w+)?$/i.test(text)){
    const accts=await storage.listReceivingAccounts(chat.id);
    if(!accts.length){await send(chat.id,'🏦 Chưa có STK nhận. Admin thêm bằng:\n/them_stk Ngân hàng | Số TK | Tên chủ TK | ghi chú');return;}
    await send(chat.id,'🏦 STK nhận của shop:\n'+accts.map(a=>`#${a.id} • ${a.bankName} • ${a.accountNo} • ${a.accountName}${noteLine(a)}`).join('\n')+'\n\nTạo QR: bấm 🏦 Tạo QR rồi chọn. Xóa: /xoa_stk <số>');
    return;
  }
  if(/^\/gan_bank(?:@\w+)?(?:\s|$)/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    await send(chat.id,'🏦 Gắn tài khoản ngân hàng cho nhóm:',{reply_markup:inline([[{text:'🏦 Mở Mini App gắn bank',web_app:{url:webAppUrlFor(chat)}}]])});
    return;
  }
  if(/^\/them_stk(?:@\w+)?(?:\s|$)/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    const spec=text.replace(/^\/them_stk(?:@\w+)?\s*/i,'').trim();
    const parts=spec.split('|').map(v=>v.trim());
    if(parts.length<3||!parts[0]||!parts[1]||!parts[2]){await send(chat.id,'⚠️ Nhập: /them_stk Ngân hàng | Số TK | Tên chủ TK | nhãn (nhãn tùy chọn)');return;}
    const bank=await vietqr.resolveBank(parts[0]);if(!bank){await send(chat.id,'⚠️ Không nhận ra ngân hàng.');return;}
    const accountNo=(parts[1].match(/\d{6,19}/)||[])[0];if(!accountNo){await send(chat.id,'⚠️ Số tài khoản không hợp lệ.');return;}
    const accountName=vietqr.normalizeAccountName(parts[2]);if(accountName.length<2){await send(chat.id,'⚠️ Tên chủ TK không hợp lệ.');return;}
    try{const a=await storage.addReceivingAccount(chat.id,actor,{bankBin:String(bank.bin),bankName:bank.shortName||bank.name,accountNo,accountName,label:parts[3]||''});await send(chat.id,`✅ Đã thêm STK nhận #${a.id}\n${a.bankName} • ${a.accountNo} • ${a.accountName}${noteLine(a)}`);}catch(e){await send(chat.id,`⚠️ ${e.message}`);}
    return;
  }
  if(/^\/xoa_stk(?:@\w+)?(?:\s|$)/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    const id=(text.replace(/^\/xoa_stk(?:@\w+)?\s*/i,'').match(/\d+/)||[])[0];
    if(!id){await send(chat.id,'⚠️ Nhập: /xoa_stk <số> (xem số ở /stk)');return;}
    const ok=await storage.removeReceivingAccount(chat.id,id,actor);await send(chat.id,ok?`✅ Đã xóa STK #${id}.`:'⚠️ Không tìm thấy STK.');
    return;
  }
  if(/^\/huygd(?:@\w+)?(?:\s|$)/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    const code=text.replace(/^\/huygd(?:@\w+)?\s*/i,'').trim();
    if(!code){await send(chat.id,'⚠️ Nhập: /huygd <Mã GD> (vd AECH-000012, xem ở /list)');return;}
    try{const r=await storage.reverseTransaction(chat.id,actor,code);await send(chat.id,r.already?`ℹ️ ${r.original.id} đã được hoàn trước đó.\nCòn lại: ${money(r.balance)}`:`✅ Đã hoàn ${r.original.id}\nBút toán đảo: ${r.reversal.id} (${r.reversal.type==='in'?'+':'-'}${money(r.reversal.gross)})\nCòn lại: ${money(r.balance)}`);}catch(e){await send(chat.id,`⚠️ ${e.message}`);}
    return;
  }

  if(state?.mode==='edit_payment'){
    const request=await storage.getPaymentRequest(chat.id,state.rawId);if(!request){sessions.delete(key);await send(chat.id,'⚠️ Không tìm thấy yêu cầu.');return;}
    const candidate={raw:request.rawText,bank:request.bankRaw,account:request.account,name:request.nameInput||request.accountName,amount:request.amount,content:request.content,note:request.note};
    if(state.field==='bank')candidate.bank=text;if(state.field==='account')candidate.account=text.match(/\d{6,19}/)?.[0]||'';if(state.field==='name')candidate.name=text;if(state.field==='amount')candidate.amount=parseAmount(text);if(state.field==='content')candidate.content=text;
    try{const prepared=await preparePayment(candidate);const updated=await storage.updatePaymentRequest(chat.id,state.rawId,state.version,actor,prepared);sessions.delete(key);await clearButtons(chat.id,state.originMessageId);await sendPaymentQr(chat.id,updated,prepared.qr,true);}catch(e){await send(chat.id,`⚠️ ${e.message}`);}return;
  }
  if(state?.mode==='setup_name'){const name=text.trim();if(!name){await send(chat.id,'⚠️ Nhập tên nhóm:',{reply_markup:forceReply()});return;}await storage.setGroupName(chat.id,name,actor);sessions.set(key,{mode:'setup_fee'});await send(chat.id,`✅ Tên nhóm: ${name}\nBước 2/3 — Nhập % PHÍ (ví dụ 1.5):`,{reply_markup:forceReply()});return;}
  if(state?.mode==='setup_fee'){const rate=parseFeeRatePercent(text);if(rate===null){await send(chat.id,'⚠️ % phí không hợp lệ. Nhập lại (vd 1.5):',{reply_markup:forceReply()});return;}await storage.setFeeRate(chat.id,rate,actor);sessions.set(key,{mode:'setup_stk'});await send(chat.id,`✅ Phí: ${formatFeeRatePercent(rate)}\nBước 3/3 — Thêm STK nhận của shop:\nGõ theo mẫu:  Ngân hàng | Số TK | Tên chủ TK\n(Vd: MB | 9704229999 | NGUYEN VAN A)\nHoặc gõ "bỏ qua" nếu chưa thêm.`,{reply_markup:forceReply()});return;}
  if(state?.mode==='setup_stk'){
    if(/^(bỏ qua|bo qua|skip|-)$/i.test(text.trim())){sessions.delete(key);await send(chat.id,'🎉 Xong cấu hình! Bắt đầu dùng được rồi.',{reply_markup:mainKeyboard()});return;}
    const parts=text.split('|').map(v=>v.trim());
    const bank=parts[0]?await vietqr.resolveBank(parts[0]):null;
    const acc=parts[1]?(parts[1].match(/\d{6,19}/)||[])[0]:null;
    if(parts.length<3||!bank||!acc){await send(chat.id,'⚠️ Chưa đúng mẫu. Gõ:  Ngân hàng | Số TK | Tên chủ TK\nHoặc "bỏ qua".',{reply_markup:forceReply()});return;}
    try{await storage.addReceivingAccount(chat.id,actor,{bankBin:String(bank.bin),bankName:bank.shortName||bank.name,accountNo:acc,accountName:vietqr.normalizeAccountName(parts[2]),label:''});sessions.delete(key);await send(chat.id,`🎉 Xong cấu hình!\n🏦 STK nhận: ${bank.shortName} • ${acc}\nBắt đầu dùng được rồi.`,{reply_markup:mainKeyboard()});}catch(e){await send(chat.id,`⚠️ ${e.message}\nGõ lại hoặc "bỏ qua".`,{reply_markup:forceReply()});}
    return;
  }
  if(state?.mode==='broadcast'){
    sessions.delete(key);
    const targets = state.target==='all' ? (await storage.listGroups()).map(g=>g.chatId) : [state.target];
    let photo=null,caption=null,textMsg=null;
    if(looksLikePaymentRequest(text)){
      const parsed=parsePaymentText(text);
      if(parsed.bank&&parsed.account){
        try{const bank=await vietqr.resolveBank(parsed.bank||parsed.raw);if(bank){const qr=await vietqr.generateStaticQr({bank,account:parsed.account,content:parsed.content});photo=qr.qrDataURL;caption=announceCaption({bankName:bank.shortName,account:parsed.account,name:parsed.name,content:qr.content,variant:state.variant});}}catch(e){console.error('Broadcast QR error:',e.message);}
      }
    }
    if(!photo) textMsg=`📢 THÔNG BÁO\n${text}`;
    await sendBroadcast(chat.id,targets,{photo,caption,textMsg});
    return;
  }
  if(state?.mode==='preset_amount'){const amount=parseAmount(text);if(!amount){await send(chat.id,'⚠️ Số tiền không hợp lệ.',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}sessions.set(key,{mode:'preset_content',presetId:state.presetId,amount:amount.toString()});await send(chat.id,'📝 Nhập nội dung chuyển khoản:',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}
  if(state?.mode==='preset_content'){const acct=await storage.getReceivingAccount(chat.id,state.presetId);if(!acct){sessions.delete(key);await send(chat.id,'⚠️ Tài khoản nhận không còn.');return;}const parsed={bank:acct.bankBin,account:acct.accountNo,name:acct.accountName,amount:BigInt(state.amount),content:text,note:'',raw:''};const request=await finalizePayment(chat,from,parsed,message.message_id);if(request)sessions.delete(key);return;}
  if((isPrivate&&text==='💰 Tiền vào')||text==='/in'){sessions.set(key,{mode:'tx',type:'in'});await send(chat.id,'💰 Nhập số tiền vào.',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}
  if((isPrivate&&text==='💸 Tiền ra')||text==='/out'){sessions.set(key,{mode:'tx',type:'out'});await send(chat.id,'💸 Nhập số tiền ra.',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}
  if(state?.mode==='tx'){const amount=parseAmount(text);if(!amount){await send(chat.id,'⚠️ Số tiền không hợp lệ.',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}sessions.delete(key);await showTransactionPreview(chat,state.type,amount,message.message_id);return;}
  if((isPrivate&&text==='🏦 Tạo QR')||text==='/qr'){
    const accts=await storage.listReceivingAccounts(chat.id);
    if(accts.length){
      const rows=accts.map(a=>[{text:`${a.bankName} • ${a.accountNo}${a.label?` · 📝 ${a.label.slice(0,25)}`:''}`,callback_data:`preset:${a.id}`}]);
      rows.push([{text:'✍️ Nhập tay',callback_data:'preset:manual'}]);
      await send(chat.id,'🏦 Chọn tài khoản nhận, hoặc nhập tay:',{reply_markup:inline(rows)});
    }else{
      sessions.set(key,{mode:'payment'});await send(chat.id,'🏦 Gửi thông tin thanh toán.',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});
    }
    return;
  }
  if(state?.mode==='payment'){const request=await createAndShowPayment(chat,from,text,message.message_id);if(request)sessions.delete(key);return;}
  if(state?.mode==='complete_payment'){
    const p={...state.p};const field=state.missing[0];
    if(field==='ngân hàng'){p.bank=text.trim();}
    else if(field==='số tài khoản'){const acc=(text.match(/\d{6,19}/)||[])[0];if(!acc){await send(chat.id,'⚠️ Số tài khoản không hợp lệ (6-19 số). Nhập lại:',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}p.account=acc;}
    else if(field==='số tiền'){const am=parseAmount(text);if(!am){await send(chat.id,'⚠️ Số tiền không hợp lệ. Nhập lại (vd 500k):',{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}p.amount=am.toString();}
    else if(field==='nội dung'){p.content=text.trim();}
    const norm={bank:p.bank,account:p.account,name:p.name,amount:p.amount?BigInt(p.amount):null,content:p.content,note:p.note,raw:p.raw};
    const miss=paymentCompleteness(norm);
    if(miss.length){sessions.set(key,{mode:'complete_payment',p,missing:miss});await send(chat.id,`👉 Nhập giúp "${miss[0]}":`,{reply_markup:forceReply(),reply_parameters:{message_id:message.message_id}});return;}
    sessions.delete(key);await finalizePayment(chat,from,norm,message.message_id);return;
  }
  if((isPrivate&&text==='📊 Tổng')||text==='/total'){await send(chat.id,await groupSummaryText(chat.id));return;}
  if(isPrivate&&text==='⚙️ Quản lý'){
    const rows=[
      [{text:'🧾 Chốt sổ',callback_data:'mng:chotso'},{text:'📄 Sao kê',callback_data:'mng:saoke'}],
      [{text:'🏦 STK nhận',callback_data:'mng:stk'},{text:'📒 Lịch sử',callback_data:'mng:list'}]
    ];
    if(access==='admin'){rows.unshift([{text:'🛠️ Cấu hình nhanh',callback_data:'mng:setup'}]);rows.unshift([{text:'🏦 Gắn bank',web_app:{url:webAppUrlFor(chat)}}]);rows.push([{text:'👥 Nhân viên',callback_data:'mng:nhanvien'},{text:'📢 Thông báo',callback_data:'mng:thongbao'}]);rows.push([{text:'💾 Backup',callback_data:'mng:backup'}]);}
    await send(chat.id,'⚙️ Quản lý — chọn chức năng:',{reply_markup:inline(rows)});
    return;
  }
  if(/^\/(kiemtra|check)(?:@\w+)?$/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính.');return;}
    const groups=await storage.listGroups();
    if(!groups.length){await send(chat.id,'Chưa có nhóm nào.');return;}
    const lines=[];
    for(const g of groups){
      let status='không vào được nhóm';
      try{if(!botUserId){const me=await telegram('getMe');botUserId=String(me?.result?.id||'');}const m=await telegram('getChatMember',{chat_id:g.chatId,user_id:botUserId});status=m?.result?.status||'?';}catch(e){status='lỗi: '+String(e.message||e).slice(0,40);}
      const ok=['creator','administrator'].includes(status);
      lines.push(`${ok?'✅':'⚠️'} ${g.name} — ${ok?'bot là Quản trị, đọc được tin khách':'bot ('+status+') CHƯA là Quản trị, không đọc tin thường'}`);
    }
    await send(chat.id,'🔎 KIỂM TRA NHÓM\n'+lines.join('\n'));return;
  }
  if((isPrivate&&text==='📢 Thông báo')||/^\/thongbao(?:@\w+)?$/i.test(text)){
    if(access!=='admin'){await send(chat.id,'⛔ Chỉ Admin chính được gửi thông báo.');return;}
    const groups=await storage.listGroups();
    if(!groups.length){await send(chat.id,'Chưa có nhóm nào.');return;}
    const rows=[[{text:`📣 Tất cả (${groups.length} nhóm)`,callback_data:'bc:all'}]];
    for(const g of groups) rows.push([{text:g.name,callback_data:`bc:${g.chatId}`}]);
    await send(chat.id,'📢 Chọn nơi gửi thông báo:',{reply_markup:inline(rows)});
    return;
  }
  if(text==='/list'||text==='/lichsu'){const rows=await storage.listTransactions(chat.id,10);if(!rows.length){await send(chat.id,'📒 Chưa có giao dịch.');return;}await send(chat.id,rows.map(t=>t.type==='in'?`🟢 ${t.id} +${money(t.gross)} • phí ${money(t.fee)}`:`🔴 ${t.id} -${money(t.gross)}`).join('\n'));return;}
  if((isPrivate&&text==='🧾 Chốt sổ')||text==='/close'){const s=await storage.dailySummary(chat.id),g=await storage.getGroup(chat.id);await send(chat.id,closeoutText(g,s,false),{reply_markup:inline([[{text:'✅ Xác nhận chốt',callback_data:`close:${s.date}`},{text:'❌ Hủy',callback_data:'tx:cancel'}]])});return;}
  const quick=isPrivate&&routing.allowQuickTransaction(text)?parseQuickTransaction(text):null;if(quick?.amount){await showTransactionPreview(chat,quick.type,quick.amount,message.message_id);return;}
  // Tin nhắn tự do (không phải lệnh /): AI phân loại ý định. Không ghi sổ khi chưa xác nhận.
  // AI phân loại tin tự do: TẮT mặc định, chỉ bật khi AI_MESSAGE_ANALYZE=1.
  if(isPrivate&&!isControl&&!state&&text&&process.env.AI_MESSAGE_ANALYZE==='1'&&AI_API_KEY){
    let a=null;
    try{a=await analyzeFreeTextMessage(text,aiChat);}catch(e){console.error('Message analyze error:',e.message);}
    if(a&&(a.intent==='transaction_in'||a.intent==='transaction_out')&&a.amount){
      const type=a.intent==='transaction_in'?'in':'out';
      const label=type==='in'?'💰 Tiền vào':'💸 Tiền ra';
      await send(chat.id,`🤖 Hiểu là: ${label}\nSố tiền: ${money(BigInt(a.amount))}${a.content?`\nNội dung: ${a.content}`:''}\n👉 Xác nhận bên dưới để ghi sổ.`,{reply_parameters:{message_id:message.message_id}});
      await showTransactionPreview(chat,type,BigInt(a.amount),message.message_id);
      return;
    }
    if(a&&a.intent==='payment_request'){
      const lines=[a.bank&&`🏦 ${a.bank}`,a.account&&`#️⃣ ${a.account}`,a.name&&`👤 ${a.name}`,a.amount&&`💵 ${money(BigInt(a.amount))}`,a.content&&`📝 ${a.content}`].filter(Boolean).join('\n');
      await send(chat.id,`🤖 Hiểu là: yêu cầu chuyển khoản\n${lines||'(chưa rõ)'}\n👉 Bấm 🏦 Tạo QR để tạo mã thanh toán.`,{reply_parameters:{message_id:message.message_id}});
      return;
    }
  }
  if(isSlash&&looksLikeExpression(text)){try{const result=evaluateExpression(text);if(result){await send(chat.id,`🧮 ${formatRational(result)}`);return;}}catch(e){await send(chat.id,`⚠️ ${e.message}`);return;}}
}

async function handleUpdate(update){if(update.my_chat_member){await registerGroupChat(update.my_chat_member.chat);return;}if(update.callback_query)return handleCallback(update.callback_query);if(update.message)return handleMessage(update.message);}
async function startTelegramBot(){
  if(!TELEGRAM_BOT_TOKEN)throw new Error('TELEGRAM_BOT_TOKEN is not set');
  try{const me=await telegram('getMe');botUserId=String(me?.result?.id||'');}catch(e){console.error('Telegram getMe error:',e.message);}
  try{await telegram('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared.');}catch(e){console.error('Telegram webhook setup error:',e.message);}
  try{await telegram('setChatMenuButton',{menu_button:{type:'web_app',text:'Gắn bank',web_app:{url:WEBAPP_URL}}});console.log('Telegram menu button set.');}catch(e){console.error('setChatMenuButton error:',e.message);}
  try{await telegram('setMyCommands',{commands:[{command:'gan_bank',description:'Mở Mini App gắn bank'},{command:'bank',description:'Xem STK nhận, QR và ghi chú'}]});console.log('Telegram commands set.');}catch(e){console.error('setMyCommands error:',e.message);}
  let offset=0;
  while(!shuttingDown){try{await storage.ensurePollLock();const data=await telegram('getUpdates',{offset,timeout:25,allowed_updates:['message','callback_query','my_chat_member']});for(const update of data.result||[]){offset=update.update_id+1;try{await handleUpdate(update);}catch(e){console.error('Update handling error:',e.message);const chatId=update.message?.chat?.id||update.callback_query?.message?.chat?.id;if(chatId)try{await send(chatId,'⚠️ Có lỗi khi xử lý. Chưa ghi giao dịch.');}catch{}}}}catch(e){console.error('Telegram polling error:',e.message);await sleep(3000);}}
}

// Mini App auth: initData (Telegram WebApp) phải có HMAC hợp lệ với TELEGRAM_BOT_TOKEN.
function miniAppUser(initData){const v=validateInitData(String(initData||''),TELEGRAM_BOT_TOKEN);return v.ok&&v.user?v.user:null;}
// v1: chỉ super admin (SUPER_ADMIN_IDS/SUPER_ADMIN_ID) hoặc ADMIN_CHAT_ID được gắn bank qua Mini App.
function miniAppIsAdmin(user){const id=String(user?.id||'');return !!id&&(isSuperAdmin(id)||(!!ADMIN_CHAT_ID&&id===ADMIN_CHAT_ID));}
// Quyền quản lý STK của một nhóm: Admin chính, hoặc chủ/quản trị nhóm Telegram (cùng luật với /gan_bank, /them_stk).
async function miniAppCanManage(user,chatId){
  if(miniAppIsAdmin(user))return true;
  if(!chatId||!user?.id)return false;
  const a=await getAccess({id:chatId,type:'supergroup'},{id:user.id});
  return a==='admin';
}
function readJsonBody(req,limit=16384){return new Promise((resolve,reject)=>{let size=0;const chunks=[];req.on('data',c=>{size+=c.length;if(size>limit){reject(new Error('too large'));req.destroy();return;}chunks.push(c);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(new Error('bad json'));}});req.on('error',reject);});}

const server=http.createServer(async(req,res)=>{
  // Liveness: còn chạy là trả 200. KHÔNG phụ thuộc DB — một lúc DB bận/chậm không được làm Railway tắt bot.
  if(req.url.split('?')[0]==='/health'){res.writeHead(ready?200:503,{'Content-Type':'application/json'});res.end(ready?'{"ok":true}':'{"ok":false}');return;}
  const pathname=req.url.split('?')[0];
  if(pathname==='/api/banks'){const banks=await vietqr.listBanks();res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=300'});res.end(JSON.stringify(banks));return;}
  if(pathname==='/api/lookup'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='GET'){send(405,{ok:false,error:'method not allowed'},{Allow:'GET'});return;}
    const q=new URL(req.url,'http://localhost').searchParams;
    const user=miniAppUser(q.get('initData'));
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    const lookupChat=receivingapi.parseChatId(q.get('chat_id'));
    if(!await miniAppCanManage(user,lookupChat)){send(403,{ok:false,error:'Chỉ Admin nhóm này hoặc Admin chính'});return;}
    const bin=String(q.get('bin')||'').trim(),account=String(q.get('account')||'').trim();
    if(!/^\d{6}$/.test(bin)||!/^\d{6,19}$/.test(account)){send(400,{ok:false,error:'invalid bin or account'});return;}
    try{const accountName=await vietqr.lookupAccount({bin},account);send(200,{ok:true,accountName});}
    catch(e){send(502,{ok:false,error:e.message});}
    return;
  }
  if(pathname==='/api/groups'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='GET'){send(405,{ok:false,error:'method not allowed'},{Allow:'GET'});return;}
    const q=new URL(req.url,'http://localhost').searchParams;
    const user=miniAppUser(q.get('initData'));
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    const chatId=receivingapi.parseChatId(q.get('chat_id'));
    try{
      const all=await storage.listGroups();
      const isSuper=miniAppIsAdmin(user);
      const list=isSuper?all.slice():[];
      if(!isSuper&&chatId&&await miniAppCanManage(user,chatId)){
        list.push(all.find(g=>g.chatId===chatId)||{chatId,name:chatId});
      }
      send(200,{ok:true,groups:groupsapi.toGroupsPayload(list)});
    }catch(e){send(500,{ok:false,error:e.message});}
    return;
  }
  if(pathname==='/api/receiving-accounts'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='GET'){send(405,{ok:false,error:'method not allowed'},{Allow:'GET'});return;}
    const q=new URL(req.url,'http://localhost').searchParams;
    const user=miniAppUser(q.get('initData'));
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    const chatId=receivingapi.parseChatId(q.get('chat_id'));
    if(!chatId){send(400,{ok:false,error:'Thiếu chat_id'});return;}
    if(!await miniAppCanManage(user,chatId)){send(403,{ok:false,error:'Chỉ Admin nhóm này hoặc Admin chính'});return;}
    try{
      const banks=await vietqr.listBanks();
      const byBin=new Map(banks.map(b=>[String(b.bin),b]));
      const accts=await storage.listReceivingAccounts(chatId);
      send(200,{ok:true,accounts:accts.map(a=>receivingapi.toApiAccount(a,byBin))});
    }catch(e){send(500,{ok:false,error:e.message});}
    return;
  }
  if(pathname==='/api/receiving-account-qr'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='GET'){send(405,{ok:false,error:'method not allowed'},{Allow:'GET'});return;}
    const q=new URL(req.url,'http://localhost').searchParams;
    const user=miniAppUser(q.get('initData'));
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    const chatId=receivingapi.parseChatId(q.get('chat_id'));
    const id=receivingapi.parseAccountId(q.get('id'));
    if(!chatId||!id){send(400,{ok:false,error:'Thiếu chat_id hoặc id'});return;}
    if(!await miniAppCanManage(user,chatId)){send(403,{ok:false,error:'Chỉ Admin nhóm này hoặc Admin chính'});return;}
    try{
      const img=await storage.getReceivingQrImage(chatId,id);
      if(!img){send(404,{ok:false,error:'STK này chưa có ảnh QR'});return;}
      send(200,{ok:true,mime:img.mime,b64:img.b64});
    }catch(e){send(500,{ok:false,error:e.message});}
    return;
  }
  if(pathname==='/api/detach-bank'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='POST'){send(405,{ok:false,error:'method not allowed'},{Allow:'POST'});return;}
    const user=miniAppUser(req.headers['x-telegram-init-data']);
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    let body;
    try{body=await readJsonBody(req);}catch{send(400,{ok:false,error:'Dữ liệu không hợp lệ'});return;}
    const chatId=receivingapi.parseChatId(body.chat_id);
    if(!chatId){send(400,{ok:false,error:'Thiếu chat_id'});return;}
    if(!await miniAppCanManage(user,chatId)){send(403,{ok:false,error:'Chỉ Admin nhóm này hoặc Admin chính'});return;}
    const id=receivingapi.parseAccountId(body.id);
    if(!id){send(400,{ok:false,error:'Thiếu id STK'});return;}
    try{
      const removed=await storage.removeReceivingAccount(chatId,id,actorFrom(user));
      if(!removed){send(404,{ok:false,error:'Không tìm thấy STK này trong nhóm'});return;}
      send(200,{ok:true,id});
    }catch(e){send(500,{ok:false,error:e.message});}
    return;
  }
  if(pathname==='/api/parse-qr-image'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='POST'){send(405,{ok:false,error:'method not allowed'},{Allow:'POST'});return;}
    const user=miniAppUser(req.headers['x-telegram-init-data']);
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    let body;
    try{body=await readJsonBody(req,1300*1024);}catch{send(400,{ok:false,error:'Dữ liệu không hợp lệ hoặc ảnh quá lớn (tối đa 700KB)'});return;}
    const chatId=String(body.chat_id||'').trim();
    if(!/^-?\d{1,20}$/.test(chatId)){send(400,{ok:false,error:'Thiếu chat_id'});return;}
    if(!await miniAppCanManage(user,chatId)){send(403,{ok:false,error:'Chỉ Admin nhóm này hoặc Admin chính'});return;}
    const decoded=qrparse.decodeUploadedQr(body.qr_image_b64,body.qr_mime);
    if(!decoded.ok){send(decoded.status,{ok:false,error:decoded.error});return;}
    try{
      const banks=await vietqr.listBanks();
      const mapped=qrparse.mapQrToFill({qrText:decoded.qrText,banks});
      if(!mapped.ok){send(mapped.status,{ok:false,error:mapped.error});return;}
      // Tên chủ TK: tra cứu VietQR nếu bật (VIETQR_LOOKUP). Lỗi/tắt → null, người dùng tự nhập.
      let accountName=null;
      try{accountName=await vietqr.lookupAccount({bin:mapped.body.bank_bin},mapped.body.account_no);}catch(e){console.error('QR account lookup:',e.message);}
      send(200,{...mapped.body,account_name:accountName?vietqr.normalizeAccountName(accountName):null});
    }catch(e){send(500,{ok:false,error:e.message});}
    return;
  }

  if(pathname==='/api/attach-bank'){
    const send=(code,obj,headers={})=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(obj));};
    if(req.method!=='POST'){send(405,{ok:false,error:'method not allowed'},{Allow:'POST'});return;}
    const user=miniAppUser(req.headers['x-telegram-init-data']);
    if(!user){send(401,{ok:false,error:'initData không hợp lệ'});return;}
    let body;
    try{body=await readJsonBody(req,1300*1024);}catch{send(400,{ok:false,error:'Dữ liệu không hợp lệ hoặc ảnh quá lớn (tối đa 700KB)'});return;}
    const chatId=String(body.chat_id||'').trim();
    if(!/^-?\d{1,20}$/.test(chatId)){send(400,{ok:false,error:'Thiếu chat_id'});return;}
    if(!await miniAppCanManage(user,chatId)){send(403,{ok:false,error:'Chỉ Admin nhóm này hoặc Admin chính'});return;}
    const bank=vietqr.getBanks().find(b=>b.bin===String(body.bank_bin||'').trim());
    if(!bank){send(400,{ok:false,error:'Ngân hàng không hợp lệ'});return;}
    const accountNo=String(body.account_no||'').trim();
    if(!/^\d{6,19}$/.test(accountNo)){send(400,{ok:false,error:'Số tài khoản không hợp lệ'});return;}
    const accountName=vietqr.normalizeAccountName(String(body.account_name||''));
    if(accountName.length<2){send(400,{ok:false,error:'Tên chủ TK không hợp lệ'});return;}
    const label=String(body.label||'').trim().slice(0,300);
    const qr=qrimage.validateQrImage({b64:body.qr_image_b64,mime:body.qr_mime});
    if(!qr.ok){send(400,{ok:false,error:qr.error});return;}
    try{
      const a=await storage.addReceivingAccount(chatId,actorFrom(user),{bankBin:bank.bin,bankName:bank.shortName||bank.name,accountNo,accountName,label,qrImageB64:qr.b64,qrMime:qr.mime});
      send(200,{ok:true,id:a.id,bankName:a.bankName,accountNo:a.accountNo,accountName:a.accountName,label:a.label,hasQrImage:!!a.hasQrImage});
    }catch(e){send(e.message.includes('đã có')?409:500,{ok:false,error:e.message});}
    return;
  }


  const deny=()=>{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('Not found');};
  let decoded;try{decoded=decodeURIComponent(pathname);}catch{res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end('Bad request');return;}
  // Chặn mọi đường dẫn có segment bắt đầu bằng "." (ví dụ .git, .env) và byte NUL.
  if(decoded.includes('\0')||decoded.split('/').some(seg=>seg.startsWith('.'))){deny();return;}
  // Allowlist: tài liệu API Mini App QR (chỉ file này, chỉ GET).
  if(decoded==='/docs/MINIAPP_QR_API.md'){
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'Content-Type':'text/plain; charset=utf-8',Allow:'GET, HEAD'});res.end('Method not allowed');return;}
    const docPath=path.join(ROOT,'docs','MINIAPP_QR_API.md');
    fs.readFile(docPath,(e,data)=>{if(e){deny();return;}res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data);});
    return;
  }
  const isIndex=decoded==='/'||decoded==='/index.html';
  const isMini=decoded.startsWith('/mini/');
  if(!isIndex&&!isMini){deny();return;}
  const fp=path.resolve(ROOT,isIndex?'index.html':'.'+decoded);
  if(isIndex&&fp!==path.join(ROOT,'index.html')){deny();return;}
  if(isMini&&!fp.startsWith(path.join(ROOT,'mini')+path.sep)){deny();return;}
  fs.readFile(fp,(e,data)=>{if(e){deny();return;}res.writeHead(200,{'Content-Type':MIME_TYPES[path.extname(fp).toLowerCase()]||'application/octet-stream'});res.end(data);});

});
async function shutdown(signal){if(shuttingDown)return;shuttingDown=true;ready=false;console.log(`${signal} received. Shutting down...`);try{await storage.close();}catch(e){console.error('Shutdown error:',e.message);}server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
server.listen(PORT,()=>{console.log(`Server is running on port ${PORT}`);(async()=>{while(!shuttingDown){try{await storage.init();ready=true;console.log('Durable storage: Postgres.');await startTelegramBot();return;}catch(e){ready=false;console.error('Bot startup error:',e.message);await sleep(3000);}}})().catch(e=>console.error('Fatal startup error:',e.message));});
