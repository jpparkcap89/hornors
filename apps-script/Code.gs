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
 *   POST {action:'poll_create' | 'poll_vote' | 'poll_add' | 'poll_close', token, …} → 투표
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
    if (p.action === 'polls') return json_({ ok: true, polls: polls_(memberOfToken_(p.token)) });
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
      case 'poll_create': return json_(pollCreate_(memberOfToken_(b.token), b.poll || {}));
      case 'poll_vote':   return json_(pollVote_(memberOfToken_(b.token), b));
      case 'poll_add':    return json_(pollAdd_(memberOfToken_(b.token), b));
      case 'poll_close':  return json_(pollClose_(memberOfToken_(b.token), b));
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

  return { ok: true, me: me, settings: publicSettings_(), members, meetingId, rsvp, paid, duesMonth: month, ledger, polls: polls_(me) };
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

/* ---------- 투표 ----------
 * Polls:       id | title | desc | kind(date/place/free) | anonymous | multi | allow_add | show(always/voted/closed) | deadline | status | created_by | created_at
 * PollOptions: poll_id | opt_id | label | sub | added_by
 * PollVotes:   poll_id | member_id | opt_ids(쉼표) | updated_at
 * 익명 투표: 중복 방지를 위해 시트에는 회원 ID가 남지만, 사이트로는 누가 골랐는지 보내지 않습니다.
 */
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function kst_(s) { s = str_(s); if (!s) return 0; const t = new Date(s.replace(' ', 'T') + (s.length <= 16 ? ':00' : '') + '+09:00').getTime(); return isNaN(t) ? 0 : t; }

function polls_(me) {
  const now = Date.now(), members = members_();
  const nick = id => (members.find(m => m.id === id) || {}).nick || '?';
  const opts = rows_('PollOptions'), votes = rows_('PollVotes');
  const list = rows_('Polls').map(r => {
    const p = {
      id: str_(r.id), title: str_(r.title), desc: str_(r.desc), kind: str_(r.kind) || 'free',
      anonymous: bool_(r.anonymous), multi: bool_(r.multi), allowAdd: bool_(r.allow_add),
      show: str_(r.show) || 'always', deadline: str_(r.deadline),
      createdBy: str_(r.created_by), createdByNick: nick(str_(r.created_by)), createdAt: str_(r.created_at)
    };
    const dl = kst_(p.deadline);
    p.closed = str_(r.status) === 'closed' || (dl > 0 && dl < now);
    const vs = votes.filter(v => str_(v.poll_id) === p.id)
      .map(v => ({ m: str_(v.member_id), o: str_(v.opt_ids).split(',').filter(String) }))
      .filter(v => v.o.length);
    const mine = vs.find(v => v.m === me);
    p.myVote = mine ? mine.o : [];
    p.voters = vs.length;
    p.canSee = p.closed || p.show === 'always' || (p.show === 'voted' && !!mine);
    p.options = opts.filter(o => str_(o.poll_id) === p.id).map(o => {
      const id = str_(o.opt_id), who = vs.filter(v => v.o.indexOf(id) >= 0);
      return {
        id, label: str_(o.label), sub: str_(o.sub), addedBy: p.anonymous ? '' : nick(str_(o.added_by)),
        count: p.canSee ? who.length : null,
        names: p.canSee && !p.anonymous ? who.map(v => nick(v.m)) : null
      };
    });
    p.mine = p.createdBy === me;
    return p;
  }).filter(p => p.id);
  const open = list.filter(p => !p.closed).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const done = list.filter(p => p.closed).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 6);
  return open.concat(done);
}

function pollRow_(id) {
  const sh = sheet_('Polls'), data = sh.getDataRange().getValues(), head = data[0].map(String);
  const i = data.findIndex((r, n) => n > 0 && str_(r[head.indexOf('id')]) === id);
  if (i < 1) throw new Error('없는 투표입니다');
  const o = {}; head.forEach((h, k) => o[h] = data[i][k]);
  const dl = kst_(o.deadline);
  o._closed = str_(o.status) === 'closed' || (dl > 0 && dl < Date.now());
  o._row = i + 1; o._sh = sh; o._head = head;
  return o;
}

function pollCreate_(me, p) {
  const title = str_(p.title), kind = ['date', 'place', 'free'].indexOf(p.kind) >= 0 ? p.kind : 'free';
  const options = (p.options || []).map(o => ({ label: str_(o.label).slice(0, 60), sub: str_(o.sub).slice(0, 200) })).filter(o => o.label);
  if (!title) throw new Error('투표 제목을 입력해 주세요');
  if (options.length < (p.allowAdd ? 1 : 2)) throw new Error('선택지를 2개 이상 넣어 주세요');
  if (options.length > 20) throw new Error('선택지는 20개까지 넣을 수 있어요');
  const show = ['always', 'voted', 'closed'].indexOf(p.show) >= 0 ? p.show : 'always';
  const deadline = str_(p.deadline).replace('T', ' ').slice(0, 16);
  const id = 'p' + Date.now().toString(36);
  const sh = sheet_('Polls'), head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const row = head.map(h => ({
    id, title: title.slice(0, 60), desc: str_(p.desc).slice(0, 300), kind,
    anonymous: !!p.anonymous, multi: !!p.multi, allow_add: !!p.allowAdd, show,
    deadline: deadline ? "'" + deadline : '', status: 'open', created_by: me,
    created_at: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss')
  })[h] ?? '');
  sh.appendRow(row);
  const os = sheet_('PollOptions');
  os.getRange(os.getLastRow() + 1, 1, options.length, 5)
    .setValues(options.map((o, k) => [id, 'o' + (k + 1), o.label, o.sub, me]));
  return { ok: true, pollId: id, polls: polls_(me) };
}

function pollVote_(me, b) {
  const p = pollRow_(str_(b.pollId));
  if (p._closed) throw new Error('마감된 투표입니다');
  const valid = rows_('PollOptions').filter(o => str_(o.poll_id) === str_(p.id)).map(o => str_(o.opt_id));
  let ids = (b.optIds || []).map(str_).filter((x, i, a) => valid.indexOf(x) >= 0 && a.indexOf(x) === i);
  if (!bool_(p.multi) && ids.length > 1) throw new Error('하나만 고를 수 있는 투표입니다');
  const sh = sheet_('PollVotes'), data = sh.getDataRange().getValues(), head = data[0].map(String);
  const cP = head.indexOf('poll_id'), cM = head.indexOf('member_id'), cO = head.indexOf('opt_ids'), cT = head.indexOf('updated_at');
  const i = data.findIndex((r, n) => n > 0 && str_(r[cP]) === str_(p.id) && str_(r[cM]) === me);
  if (!ids.length) { if (i > 0) sh.deleteRow(i + 1); }                       // 투표 취소
  else if (i > 0) { sh.getRange(i + 1, cO + 1).setValue("'" + ids.join(',')); sh.getRange(i + 1, cT + 1).setValue(new Date()); }
  else { const row = []; row[cP] = p.id; row[cM] = me; row[cO] = "'" + ids.join(','); row[cT] = new Date(); sh.appendRow(row); }
  return { ok: true, polls: polls_(me) };
}

function pollAdd_(me, b) {
  const p = pollRow_(str_(b.pollId));
  if (p._closed) throw new Error('마감된 투표입니다');
  if (!bool_(p.allow_add) && str_(p.created_by) !== me) throw new Error('항목 추가가 허용되지 않은 투표입니다');
  const label = str_(b.label).slice(0, 60), sub = str_(b.sub).slice(0, 200);
  if (!label) throw new Error('추가할 항목을 입력해 주세요');
  const mine = rows_('PollOptions').filter(o => str_(o.poll_id) === str_(p.id));
  if (mine.length >= 20) throw new Error('선택지는 20개까지예요');
  if (mine.some(o => str_(o.label) === label && str_(o.sub) === sub)) throw new Error('이미 있는 항목이에요');
  const n = mine.reduce((mx, o) => Math.max(mx, Number(str_(o.opt_id).slice(1)) || 0), 0) + 1;
  sheet_('PollOptions').appendRow([p.id, 'o' + n, label, sub, me]);
  return { ok: true, optId: 'o' + n, polls: polls_(me) };
}

function pollClose_(me, b) {
  const p = pollRow_(str_(b.pollId));
  const isAdmin = b.adminToken && CacheService.getScriptCache().get('adm:' + b.adminToken);
  if (str_(p.created_by) !== me && !isAdmin) throw new Error('만든 사람이나 관리자만 마감할 수 있어요');
  p._sh.getRange(p._row, p._head.indexOf('status') + 1).setValue(b.reopen ? 'open' : 'closed');
  return { ok: true, polls: polls_(me) };
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
