/**
 * Q 아너스 백엔드 (Google Apps Script 웹 앱)
 * 시트: Settings · Members · Meetings · RSVP · Ledger · Dues
 *
 * 공개(로그인 전)
 *   GET  ?action=boot                  → 사이트 문구 + 로그인용 이름 목록(연락처 없음)
 *   POST {action:'login', memberId, pin} → 회원 토큰(90일)
 * 회원 전용(토큰 필요)
 *   GET  ?action=data&token=…          → 회원 연락처·참석 응답·회비·장부
 *   POST {action:'rsvp', token, status}
 *   POST {action:'admin', token, pin}  → 관리자 토큰(6시간)
 *   POST {action:'profile', token, nick, phone, email, pin} → 본인 정보만 수정
 * 관리자 전용
 *   POST {action:'settings', adminToken, changes}
 *   POST {action:'members',  adminToken, list}
 *
 * 회원 PIN: Members 시트 pin 칸(4자리). 비어 있으면 전화번호 뒷자리 4자리.
 * ※ 사이트는 POST 본문을 text/plain 으로 보냅니다(브라우저 CORS 사전요청 회피).
 */

const SECRET_KEYS = ['ADMIN_PIN'];      // 웹으로 절대 내보내지 않는 Settings 키
const STATUS = ['yes', 'maybe', 'no'];
const MEMBER_TTL_DAYS = 90;
const ADMIN_TTL = 6 * 60 * 60;          // 초
const MAX_FAIL = 5;                     // 10분 안에 PIN 5번 틀리면 잠금

/* ---------- 진입점 ---------- */
function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'boot' || !p.action) return json_(boot_());
    if (p.action === 'data') return json_(data_(memberOfToken_(p.token)));
    if (p.action === 'ping') return json_({ ok: true, at: new Date().toISOString() });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), code: err.code || '' });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (b.action === 'login') return json_(login_(b));
    lock.waitLock(10000);
    switch (b.action) {
      case 'rsvp':     return json_(saveRsvp_(memberOfToken_(b.token), b.status));
      case 'admin':    return json_(adminLogin_(memberOfToken_(b.token), b.pin));
      case 'profile':  return json_(saveProfile_(memberOfToken_(b.token), b));
      case 'settings': requireAdmin_(b.adminToken); return json_(saveSettings_(b.changes || {}));
      case 'members':  requireAdmin_(b.adminToken); return json_(saveMembers_(b.list || []));
      default:         return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err), code: err.code || '' });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ---------- 공개 ---------- */
function boot_() {
  const settings = publicSettings_();
  const roster = members_().filter(m => m.active).map(m => ({ id: m.id, name: m.name, nick: m.nick, role: m.role }));
  return { ok: true, settings, roster };
}

function login_(b) {
  const id = str_(b.memberId), pin = str_(b.pin).replace(/\D/g, '');
  const cache = CacheService.getScriptCache(), fk = 'fail:' + id;
  const fails = Number(cache.get(fk)) || 0;
  if (fails >= MAX_FAIL) return { ok: false, error: 'PIN을 여러 번 틀렸어요. 10분 뒤에 다시 해 주세요', code: 'locked' };
  const m = members_().find(x => x.id === id && x.active);
  if (!m) return { ok: false, error: '없는 회원입니다' };
  const expect = m.pin || m.phone.replace(/\D/g, '').slice(-4);
  if (!expect) return { ok: false, error: 'PIN이 아직 없어요. 총무님께 문의해 주세요', code: 'nopin' };
  if (pin !== expect) {
    cache.put(fk, String(fails + 1), 600);
    Utilities.sleep(700);
    return { ok: false, error: 'PIN이 맞지 않아요', left: MAX_FAIL - fails - 1 };
  }
  cache.remove(fk);
  const token = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  cleanTokens_(props);
  props.setProperty('tok:' + token, JSON.stringify({ m: id, exp: Date.now() + MEMBER_TTL_DAYS * 864e5 }));
  return { ok: true, token, memberId: id };
}

/* ---------- 회원 전용 ---------- */
function data_(me) {
  const settings = readSettings_();
  const meetingId = settings.NEXT_MEETING_ID || '';
  const members = members_().map(m => { const o = Object.assign({}, m); delete o.pin; return o; });

  const rsvp = {};
  rows_('RSVP').forEach(r => {
    if (str_(r.meeting_id) === meetingId && STATUS.indexOf(str_(r.status)) >= 0) rsvp[str_(r.member_id)] = str_(r.status);
  });
  const month = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM');
  const paid = rows_('Dues').filter(r => monthOf_(r.month) === month).map(r => str_(r.member_id));
  const ledger = rows_('Ledger').map(r => ({
    date: dateStr_(r.date), type: str_(r.type), title: str_(r.title), memberId: str_(r.member_id),
    amount: Number(r.amount) || 0, memo: str_(r.memo)
  })).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40);

  return { ok: true, me: me, settings: publicSettings_(), members, meetingId, rsvp, paid, duesMonth: month, ledger };
}

function saveRsvp_(memberId, status) {
  status = str_(status);
  if (STATUS.indexOf(status) < 0) throw new Error('잘못된 응답');
  const meetingId = readSettings_().NEXT_MEETING_ID || '';
  const sh = sheet_('RSVP'), data = sh.getDataRange().getValues(), head = data[0].map(String);
  const cM = head.indexOf('meeting_id'), cU = head.indexOf('member_id'), cS = head.indexOf('status'), cT = head.indexOf('updated_at');
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (str_(data[i][cM]) === meetingId && str_(data[i][cU]) === memberId) {
      sh.getRange(i + 1, cS + 1).setValue(status);
      sh.getRange(i + 1, cT + 1).setValue(now);
      return { ok: true };
    }
  }
  const row = []; row[cM] = meetingId; row[cU] = memberId; row[cS] = status; row[cT] = now;
  sh.appendRow(row);
  return { ok: true };
}

function adminLogin_(memberId, pin) {
  const expect = readSettings_().ADMIN_PIN;
  if (!expect) throw new Error('Settings 시트에 ADMIN_PIN을 먼저 넣어 주세요');
  const cache = CacheService.getScriptCache(), fk = 'afail:' + memberId;
  const fails = Number(cache.get(fk)) || 0;
  if (fails >= MAX_FAIL) return { ok: false, error: '여러 번 틀렸어요. 10분 뒤에 다시 해 주세요' };
  if (str_(pin) !== str_(expect)) {
    cache.put(fk, String(fails + 1), 600);
    Utilities.sleep(800);
    return { ok: false, error: 'PIN이 맞지 않습니다' };
  }
  cache.remove(fk);
  const token = Utilities.getUuid();
  cache.put('adm:' + token, memberId, ADMIN_TTL);
  return { ok: true, adminToken: token };
}

function saveProfile_(memberId, b) {
  const nick = str_(b.nick), email = str_(b.email), pin = str_(b.pin).replace(/\D/g, '');
  let phone = str_(b.phone).replace(/\D/g, '');
  if (!nick) throw new Error('닉네임을 입력해 주세요');
  if (nick.length > 12) throw new Error('닉네임은 12자 이내로 입력해 주세요');
  if (phone && !/^01\d{8,9}$/.test(phone)) throw new Error('휴대폰 번호를 확인해 주세요');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('메일 주소를 확인해 주세요');
  if (pin && pin.length !== 4) throw new Error('PIN은 숫자 4자리로 입력해 주세요');
  const sh = sheet_('Members'), data = sh.getDataRange().getValues(), head = data[0].map(String);
  const col = n => head.indexOf(n);
  const i = data.findIndex((r, n) => n > 0 && str_(r[col('id')]) === memberId);
  if (i < 1) throw new Error('회원을 찾지 못했어요');
  sh.getRange(i + 1, col('nick') + 1).setValue(nick);
  sh.getRange(i + 1, col('phone') + 1).setValue(phone ? "'" + phone_(phone) : '');
  sh.getRange(i + 1, col('email') + 1).setValue(email);
  if (pin && col('pin') >= 0) sh.getRange(i + 1, col('pin') + 1).setValue("'" + pin);
  return { ok: true, member: { id: memberId, nick: nick, phone: phone ? phone_(phone) : '', email: email } };
}

/* ---------- 관리자 전용 ---------- */
function saveSettings_(changes) {
  const sh = sheet_('Settings'), data = sh.getDataRange().getValues(), head = data[0].map(String);
  const cK = head.indexOf('key'), cV = head.indexOf('value');
  Object.keys(changes).forEach(k => {
    if (SECRET_KEYS.indexOf(k) >= 0) return;
    const i = data.findIndex((r, n) => n > 0 && str_(r[cK]) === k);
    if (i > 0) sh.getRange(i + 1, cV + 1).setValue(String(changes[k]));
    else { const row = []; row[cK] = k; row[cV] = String(changes[k]); sh.appendRow(row); }
  });
  return { ok: true };
}

function saveMembers_(list) {
  const sh = sheet_('Members'), data = sh.getDataRange().getValues(), head = data[0].map(String);
  const col = n => head.indexOf(n);
  const F = ['name', 'nick', 'role', 'phone', 'email', 'active'];
  let maxOrder = 0;
  data.slice(1).forEach(r => { maxOrder = Math.max(maxOrder, Number(r[col('order')]) || 0); });
  list.forEach(m => {
    if (!m || !m.id) return;
    const i = data.findIndex((r, n) => n > 0 && str_(r[col('id')]) === m.id);
    const v = {
      name: str_(m.name), nick: str_(m.nick), role: str_(m.role),
      phone: m.phone ? "'" + str_(m.phone) : '', email: str_(m.email), active: m.active !== false
    };
    const pin = str_(m.pin).replace(/\D/g, '');
    if (i > 0) {
      F.forEach(f => sh.getRange(i + 1, col(f) + 1).setValue(v[f]));
      if (pin.length === 4 && col('pin') >= 0) sh.getRange(i + 1, col('pin') + 1).setValue("'" + pin);
    } else {
      const row = []; row[col('id')] = m.id; F.forEach(f => row[col(f)] = v[f]); row[col('order')] = ++maxOrder;
      if (col('pin') >= 0) row[col('pin')] = pin.length === 4 ? "'" + pin : '';
      sh.appendRow(row);
    }
  });
  return { ok: true };
}

/* ---------- 인증 도우미 ---------- */
function memberOfToken_(token) {
  const raw = token && PropertiesService.getScriptProperties().getProperty('tok:' + token);
  const t = raw ? JSON.parse(raw) : null;
  if (!t || t.exp < Date.now()) { const e = new Error('다시 로그인해 주세요'); e.code = 'auth'; throw e; }
  const m = members_().find(x => x.id === t.m && x.active);
  if (!m) { const e = new Error('휴면 또는 없는 회원입니다'); e.code = 'auth'; throw e; }
  return m.id;
}
function requireAdmin_(adminToken) {
  if (!adminToken || !CacheService.getScriptCache().get('adm:' + adminToken)) {
    const e = new Error('관리자 로그인이 필요합니다'); e.code = 'admin'; throw e;
  }
}
function cleanTokens_(props) {
  const all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(k => {
    if (k.indexOf('tok:') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

/* ---------- 시트 도우미 ---------- */
function members_() {
  return rows_('Members').map(r => ({
    id: str_(r.id), name: str_(r.name), nick: str_(r.nick), role: str_(r.role),
    phone: phone_(r.phone), email: str_(r.email), pin: str_(r.pin).replace(/\D/g, ''),
    active: !(r.active === false || String(r.active).toUpperCase() === 'FALSE'),
    order: Number(r.order) || 999
  })).filter(m => m.id).sort((a, b) => a.order - b.order);
}
function readSettings_() {
  const out = {};
  rows_('Settings').forEach(r => { if (r.key) out[str_(r.key)] = str_(r.value); });
  return out;
}
function publicSettings_() {
  const s = readSettings_(); SECRET_KEYS.forEach(k => delete s[k]); return s;
}
function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error(name + ' 시트가 없습니다');
  return sh;
}
function rows_(name) {
  const v = sheet_(name).getDataRange().getValues();
  const head = v.shift().map(h => String(h).trim());
  return v.filter(r => r.some(c => c !== '' && c !== null)).map(r => {
    const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i]; }); return o;
  });
}
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function phone_(v) {
  let d = str_(v).replace(/\D/g, '');
  if (/^10\d{8}$/.test(d)) d = '0' + d;          // 숫자로 저장돼 앞자리 0이 빠진 경우
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  if (d.length === 10) return d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  return str_(v);
}
function monthOf_(v) { return v instanceof Date ? Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM') : str_(v).slice(0, 7); }
function dateStr_(v) { return v instanceof Date ? Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd') : str_(v); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/* 편집기에서 ▶ 실행해 연결을 점검하는 함수 */
function testBoot() { Logger.log(JSON.stringify(boot_(), null, 2)); }
