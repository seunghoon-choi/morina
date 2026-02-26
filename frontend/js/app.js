'use strict';

const API = '';
let currentTaxpayerId = null;
let currentHistId     = null;
let _backCallback     = null;
let _actionCtx        = null; // 'analyze' | 'history'

/* ── 유틸 ───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const fmt    = (n, unit='원') => n == null ? '-' : Number(n).toLocaleString('ko-KR') + unit;
const fmtPct = v => v == null ? '-' : Number(v).toFixed(2) + '%';
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

/* ── 인증: authFetch 래퍼 ──────────────────────────────────────── */
const authFetch = (url, opts = {}) => {
  const token = localStorage.getItem('byetax_token');
  return fetch(url, {
    ...opts,
    headers: {
      ...opts.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    }
  });
};

/* ── 인증: 초기화 및 로그인/로그아웃 ───────────────────────────── */
async function initAuth() {
  // ?token= 파라미터 처리 (카카오 OAuth 콜백)
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem('byetax_token', urlToken);
    params.delete('token');
    const qs = params.toString();
    history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  // 공유 모드 — 인증 불필요
  const shareToken = new URLSearchParams(window.location.search).get('share');
  if (shareToken) {
    hide('login-screen');
    enterShareMode(shareToken);
    return;
  }

  // JWT 낙관적 검증
  const token = localStorage.getItem('byetax_token');
  if (token) {
    hide('login-screen'); // 낙관적 숨김
    try {
      const res = await fetch(`${API}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        updateUserArea(await res.json());
        return;
      }
    } catch {}
    localStorage.removeItem('byetax_token');
    show('login-screen');
    return;
  }
  // 토큰 없음 — 로그인 화면이 기본으로 표시됨
}

function updateUserArea(user) {
  if (!user) return;
  show('user-area');
  if (user.nickname) $('user-name').textContent = user.nickname;
  const avatar = $('user-avatar');
  if (user.profile_image) {
    avatar.src = user.profile_image;
    avatar.style.display = 'block';
  } else {
    avatar.style.display = 'none';
  }
}

function kakaoLogin() {
  window.location.href = `${API}/auth/kakao/login`;
}

async function devLogin() {
  try {
    const res  = await fetch(`${API}/auth/dev-login?nickname=테스트사용자`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '로그인 실패');
    localStorage.setItem('byetax_token', data.access_token);
    hide('login-screen');
    updateUserArea({ nickname: data.nickname, profile_image: '' });
  } catch (err) {
    showToast('로그인 실패: ' + err.message);
  }
}

function logout() {
  localStorage.removeItem('byetax_token');
  hide('user-area');
  resetUI();
  show('login-screen');
}

/* ── 헤더 상태 관리 ─────────────────────────────────────────────── */
function setHeaderState(state) {
  const states = {
    default: { back: false, logo: true,  title: '' },
    result:  { back: true,  logo: false, title: '분석 완료',    cb: () => resetUI() },
    detail:  { back: true,  logo: false, title: '상세 정보',    cb: () => closeHistoryDetail() },
    share:   { back: false, logo: false, title: '공유된 분석 결과' },
  };
  const s = states[state] || states.default;

  s.back ? show('btn-header-back') : hide('btn-header-back');
  s.logo ? show('logo-area')       : hide('logo-area');

  if (s.title) {
    $('header-page-title').textContent = s.title;
    show('header-page-title');
  } else {
    hide('header-page-title');
  }

  _backCallback = s.cb || null;
}

function handleBack() {
  if (_backCallback) _backCallback();
}

/* ── 액션 바 ─────────────────────────────────────────────────────── */
function showActionBar(context) {
  _actionCtx = context;
  show('action-bar');
  document.body.classList.add('action-bar-visible');
}
function hideActionBar() {
  _actionCtx = null;
  hide('action-bar');
  document.body.classList.remove('action-bar-visible');
}
function getActiveId() {
  return _actionCtx === 'history' ? currentHistId : currentTaxpayerId;
}
function actionExcel() { downloadExcelById(getActiveId()); }
function actionShare() { createShareLink(getActiveId()); }

/* ── 탭 전환 ─────────────────────────────────────────────────────── */
function switchTab(tab) {
  ['analyze', 'history'].forEach(t => {
    $(`tab-${t}`).classList.toggle('hidden', t !== tab);
    $(`nav-item-${t}`).classList.toggle('active', t === tab);
  });

  // 탭별 헤더 & 액션바 동기화
  if (tab === 'analyze') {
    if (!$('result-section').classList.contains('hidden')) {
      setHeaderState('result');
      showActionBar('analyze');
    } else {
      setHeaderState('default');
      hideActionBar();
    }
  } else {
    if (!$('history-detail').classList.contains('hidden')) {
      setHeaderState('detail');
      showActionBar('history');
    } else {
      setHeaderState('default');
      hideActionBar();
    }
    loadHistory();
  }
}

/* ── 드롭존 이벤트 ──────────────────────────────────────────────── */
let selectedFile = null;
const dropZone  = $('drop-zone');
const fileInput = $('pdf-input');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) setFile(e.target.files[0]); });

function setFile(file) {
  if (!file.name.toLowerCase().endsWith('.pdf')) { showError('PDF 파일만 업로드 가능합니다.'); return; }
  selectedFile = file;
  $('file-name-text').textContent = file.name;
  show('file-info'); show('btn-analyze'); hide('error-box');
}
function clearFile() {
  selectedFile = null; fileInput.value = '';
  hide('file-info'); hide('btn-analyze');
}

/* ── UI 상태 전환 ────────────────────────────────────────────────── */
function resetUI() {
  clearFile();
  hide('loading'); hide('result-section'); hide('error-box');
  show('upload-section');

  // 분석 탭으로 전환 (탭 상태 직접 처리)
  $('tab-analyze').classList.remove('hidden');
  $('tab-history').classList.add('hidden');
  $('nav-item-analyze').classList.add('active');
  $('nav-item-history').classList.remove('active');

  setHeaderState('default');
  hideActionBar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(msg) {
  $('error-msg').textContent = msg;
  show('error-box'); hide('loading'); show('upload-section');
}

/* ── PDF 업로드 ──────────────────────────────────────────────────── */
async function uploadPDF() {
  if (!selectedFile) return;
  hide('upload-section'); hide('error-box'); show('loading');

  const form = new FormData();
  form.append('file', selectedFile);

  try {
    const res  = await authFetch(`${API}/upload`, { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || '서버 오류');

    currentTaxpayerId = json.taxpayer_id;
    hide('loading');
    renderResult(json.data, json.taxpayer_id);
    show('result-section');
    setHeaderState('result');
    showActionBar('analyze');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    loadCalc(json.taxpayer_id, '');
    loadAI(json.taxpayer_id, '');

  } catch (err) {
    showError(err.message || '알 수 없는 오류가 발생했습니다.');
  }
}

/* ── 결과 렌더링 (공통) ──────────────────────────────────────────── */
function renderResult(data, taxpayerId, suffix = '') {
  renderTaxpayer(data.taxpayer || data,          suffix);
  renderBusinesses(data.businesses  || [], suffix);
  renderTaxHistory(data.tax_history || [], suffix);
  renderIncomeRate(data.income_rate_history || [], suffix);
  renderSgExpenses(data.sg_expenses || [], suffix);
  renderDeductions(data.deductions  || [], suffix);
  renderCreditCard(data.credit_card_usage || [], suffix);
  renderOtherIncomes(data.other_incomes || [], suffix);
  renderPenalties(data.penalty_taxes || [], suffix);
}

/* ── 납세자 기본정보 ─────────────────────────────────────────────── */
function renderTaxpayer(tp, suffix = '') {
  const id = `card-taxpayer${suffix}`;
  if (!$(id)) return;
  const items = [
    ['귀속연도', tp.tax_year ? `${tp.tax_year}년` : '-'],
    ['성명',     tp.name         || '-'],
    ['생년월일', tp.birth_date   || '-'],
    ['기장의무', tp.bookkeeping_obligation   || '-'],
    ['경비율',   tp.estimated_expense_rate   || '-'],
    ['안내유형', tp.guide_type   || '-'],
  ];
  $(id).innerHTML = items.map(([l, v]) =>
    `<div class="info-item"><div class="info-label">${l}</div><div class="info-value">${v}</div></div>`
  ).join('');
}

/* ── 사업장별 수입금액 ────────────────────────────────────────────── */
function renderBusinesses(list, suffix = '') {
  const badge = $(`biz-total-badge${suffix}`);
  const tbody = $(`tbody-businesses${suffix}`);
  if (!tbody) return;

  const total = list.reduce((s, b) => s + (b.revenue || 0), 0);
  if (badge) badge.textContent = `총 ${fmt(total)}`;

  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="9">데이터 없음</td></tr>'; return; }

  const isShort = suffix === '-h';
  tbody.innerHTML = list.map(b => isShort ? `
    <tr>
      <td data-label="사업자번호"><code style="font-size:12px">${b.business_reg_no || '-'}</code></td>
      <td data-label="상호" style="font-weight:600">${b.business_name || '-'}</td>
      <td data-label="수입종류">${b.income_type_code || '-'}</td>
      <td data-label="경비율">${b.expense_rate_type || '-'}</td>
      <td data-label="수입금액" class="num" style="color:#1d4ed8;font-weight:700">${fmt(b.revenue)}</td>
    </tr>` : `
    <tr>
      <td data-label="사업자번호"><code style="font-size:12px">${b.business_reg_no || '-'}</code></td>
      <td data-label="상호" style="font-weight:600">${b.business_name || '-'}</td>
      <td data-label="수입종류">${b.income_type_code || '-'}</td>
      <td data-label="업종코드">${b.industry_code || '-'}</td>
      <td data-label="사업형태"><span class="chip chip-none" style="padding:3px 8px;font-size:12px">${b.business_type || '-'}</span></td>
      <td data-label="경비율">${b.expense_rate_type || '-'}</td>
      <td data-label="수입금액" class="num" style="color:#1d4ed8;font-size:15px">${fmt(b.revenue)}</td>
      <td data-label="기준경비율" class="num">${fmtPct(b.std_expense_rate_general)}</td>
      <td data-label="단순경비율" class="num">${fmtPct(b.simple_expense_rate_general)}</td>
    </tr>`
  ).join('');
}

/* ── 최근 3년 종합소득세 ───────────────────────────────────────────── */
function renderTaxHistory(list, suffix = '') {
  if (!list.length) return;
  list.forEach((h, i) => {
    const el = $(`yr-${i}${suffix}`);
    if (el) el.textContent = `${h.attribution_year}귀속`;
  });
  const rows = [
    { label: '종합소득금액', key: 'total_income' },
    { label: '소득공제',     key: 'income_deduction' },
    { label: '과세표준',     key: 'taxable_income',  bold: true },
    { label: '세율',         key: 'tax_rate',        pct: true },
    { label: '산출세액',     key: 'calculated_tax' },
    { label: '공제·감면세액', key: 'deduction_tax' },
    { label: '결정세액',     key: 'determined_tax',  bold: true },
    { label: '실효세율',     key: 'effective_tax_rate', pct: true },
  ];
  const tbody = $(`tbody-history${suffix}`);
  if (!tbody) return;
  tbody.innerHTML = rows.map(row => {
    const cells = list.map(h => {
      const v = h[row.key];
      return `<td class="num">${row.pct ? fmtPct(v) : fmt(v, '')}</td>`;
    }).join('');
    return `<tr class="${row.bold ? 'total-row' : ''}"><td class="row-label">${row.label}</td>${cells}</tr>`;
  }).join('');
}

/* ── 신고소득률 ─────────────────────────────────────────────────────── */
function renderIncomeRate(list, suffix = '') {
  const tbody = $(`tbody-income-rate${suffix}`);
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">데이터 없음</td></tr>'; return; }
  tbody.innerHTML = list.map(r => {
    const rc = (r.income_rate || 0) < 0 ? 'rate-neg' : 'rate-pos';
    return `<tr>
      <td style="font-weight:700">${r.attribution_year}년</td>
      <td class="num">${fmt(r.revenue, '')}</td>
      <td class="num">${fmt(r.necessary_expenses, '')}</td>
      <td class="num ${(r.income || 0) < 0 ? 'rate-neg' : ''}">${fmt(r.income, '')}</td>
      <td class="num ${rc}">${fmtPct(r.income_rate)}</td>
    </tr>`;
  }).join('');
}

/* ── 판관비율 ──────────────────────────────────────────────────────── */
function renderSgExpenses(list, suffix = '') {
  const tbody = $(`tbody-sg${suffix}`);
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="4">데이터 없음</td></tr>'; return; }
  tbody.innerHTML = list.map(sg => `
    <tr>
      <td>${sg.account_code ? sg.account_code + '.' : ''}${sg.account_name || '-'}</td>
      <td class="num">${fmt(sg.amount, '')}</td>
      <td class="num">${fmtPct(sg.company_rate)}</td>
      <td class="num">${fmtPct(sg.industry_avg_rate)}</td>
    </tr>`).join('');
}

/* ── 공제 참고자료 ───────────────────────────────────────────────── */
function renderDeductions(list, suffix = '') {
  const tbody = $(`tbody-deductions${suffix}`);
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="3">데이터 없음</td></tr>'; return; }
  tbody.innerHTML = list.map(d => `
    <tr>
      <td style="font-weight:600;white-space:nowrap">${d.category}</td>
      <td>${d.item_name}</td>
      <td class="num" style="color:${(d.amount||0)>0?'#1d4ed8':'#6b7280'};font-weight:${(d.amount||0)>0?'700':'400'}">
        ${fmt(d.amount)}
      </td>
    </tr>`).join('');
}

/* ── 신용카드 사용현황 ─────────────────────────────────────────────── */
function renderCreditCard(list, suffix = '') {
  const tbody = $(`tbody-card${suffix}`);
  const chart = $(`card-chart${suffix}`);
  if (!tbody) return;
  if (!list.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="3">데이터 없음</td></tr>'; return; }

  const total = (list.find(c => c.category === '합계') || {}).amount || 1;
  tbody.innerHTML = list.map(c => `
    <tr style="${c.category==='합계'?'font-weight:700;background:#f3f4f6':''}">
      <td>${c.category}</td>
      <td class="num">${c.count != null ? c.count.toLocaleString()+'건' : '-'}</td>
      <td class="num" style="color:${c.category==='합계'?'#1d4ed8':'#374151'}">${fmt(c.amount)}</td>
    </tr>`).join('');

  if (!chart) return;
  const colors = ['#2563eb','#7c3aed','#db2777','#d97706','#16a34a'];
  const items  = list.filter(c => c.category !== '합계' && (c.amount || 0) > 0);
  chart.innerHTML = items.map((c, i) => {
    const pct = Math.round(c.amount / total * 100);
    return `<div class="chart-bar-row">
      <div class="chart-label"><span>${c.category}</span><span style="font-weight:600">${pct}%</span></div>
      <div class="chart-bar-bg">
        <div class="chart-bar-fill" style="width:${pct}%;background:${colors[i%colors.length]}"></div>
      </div></div>`;
  }).join('');
}

/* ── 타소득 자료유무 ───────────────────────────────────────────────── */
function renderOtherIncomes(list, suffix = '') {
  const el = $(`other-income-chips${suffix}`);
  if (!el) return;
  const labels = { '이자':'이자소득','배당':'배당소득','근로단일':'근로(단일)',
                   '근로복수':'근로(복수)','연금':'연금소득','기타':'기타소득' };
  el.innerHTML = list.map(oi => {
    const has = oi.has_data === 'O';
    return `<span class="chip ${has?'chip-has':'chip-none'}">${has?'●':'○'} ${labels[oi.income_type]||oi.income_type}</span>`;
  }).join('');
}

/* ── 가산세 항목 ─────────────────────────────────────────────────── */
function renderPenalties(list, suffix = '') {
  const tbody = $(`tbody-penalty${suffix}`);
  if (!tbody) return;
  const meaningful = list.filter(p => p.count != null || p.amount != null);
  if (!meaningful.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="3">해당 없음</td></tr>'; return; }
  tbody.innerHTML = meaningful.map(p => {
    const val = p.count != null ? `${p.count.toLocaleString()}건` : fmt(p.amount);
    const issue = (p.count || 0) > 0 || (p.amount || 0) > 0;
    return `<tr>
      <td style="${issue?'color:#dc2626;font-weight:700':''}">${p.penalty_type}</td>
      <td>${p.detail_type || '-'}</td>
      <td class="num" style="${issue?'color:#dc2626;font-weight:700':'color:#6b7280'}">${val}</td>
    </tr>`;
  }).join('');
}

/* ── 세금 계산 로드 & 렌더 ────────────────────────────────────────── */
async function loadCalc(taxpayerId, suffix = '') {
  const loadId  = `calc-loading${suffix}`;
  const stepsId = `calc-steps${suffix}`;
  if (!$(loadId)) return;
  show(loadId);

  try {
    const res  = await authFetch(`${API}/taxpayers/${taxpayerId}/calculate`);
    const data = await res.json();
    hide(loadId);
    if (!$(stepsId)) return;

    if (data.error) { $(stepsId).innerHTML = `<div class="calc-error">${data.error}</div>`; return; }

    const finalTax = data.final_tax || 0;
    const isRefund = finalTax < 0;

    $(stepsId).innerHTML = `
      <div class="calc-table">
        ${data.steps.map(s => {
          if (s.final) return `
            <div class="calc-row calc-final ${isRefund ? 'refund' : 'payable'}">
              <span class="calc-label">${s.label}</span>
              <span class="calc-value">${fmt(Math.abs(s.value))}${isRefund?' (환급)':''}</span>
            </div>`;
          if (s.value == null) return `
            <div class="calc-row">
              <span class="calc-label">${s.label}</span>
              <span class="calc-value calc-rate">${data.tax_rate}%</span>
            </div>`;
          return `
            <div class="calc-row ${s.bold ? 'calc-subtotal' : ''}">
              <span class="calc-label">${s.label}</span>
              <span class="calc-value">${fmt(s.value)}</span>
            </div>`;
        }).join('')}
      </div>`;
  } catch {
    hide(loadId);
    if ($(stepsId)) $(stepsId).innerHTML = '<div class="calc-error">계산 오류</div>';
  }
}

/* ── AI 분석 로드 & 렌더 ──────────────────────────────────────────── */
async function loadAI(taxpayerId, suffix = '') {
  const loadId     = `ai-loading${suffix}`;
  const commentsId = `ai-comments${suffix}`;
  const noteId     = `ai-note${suffix}`;
  const badgeId    = `ai-risk-badge${suffix}`;
  if (!$(loadId)) return;
  show(loadId);

  try {
    const res  = await authFetch(`${API}/taxpayers/${taxpayerId}/ai-analysis`);
    const data = await res.json();
    hide(loadId);

    const badge = $(badgeId);
    if (badge) {
      badge.textContent = `위험도: ${data.risk_label}`;
      badge.className   = `risk-badge risk-${data.risk_level}`;
      badge.classList.remove('hidden');
    }

    const TYPE_LABEL = { success:'양호', info:'안내', warning:'주의', danger:'위험' };
    if ($(commentsId)) {
      $(commentsId).innerHTML = (data.comments || []).map(c => `
        <div class="ai-comment ai-comment-${c.type}">
          <div class="ai-comment-title">
            <span class="ai-type-tag ai-type-${c.type}">${TYPE_LABEL[c.type]||c.type}</span>
            ${c.title}
          </div>
          <div class="ai-comment-body">${c.body}</div>
        </div>`).join('');
    }
    if ($(noteId) && data.note) {
      $(noteId).innerHTML = `<div class="ai-note-text">* ${data.note}</div>`;
    }
  } catch {
    hide(loadId);
  }
}

/* ── 공유 링크 ───────────────────────────────────────────────────── */
async function createShareLink(id) {
  if (!id) return;
  try {
    const res = await authFetch(`${API}/taxpayers/${id}/share`, { method: 'POST' });
    if (!res.ok) throw new Error('공유 링크 생성 실패');
    const data     = await res.json();
    const shareUrl = `${window.location.origin}${window.location.pathname}?share=${data.token}`;
    openShareModal(shareUrl);
  } catch (err) {
    showToast('공유 오류: ' + err.message);
  }
}

function openShareModal(url) {
  $('share-url-input').value = url;
  show('share-modal');
  document.body.style.overflow = 'hidden';
}

function closeShareModal(e) {
  if (e && e.target !== e.currentTarget) return;
  hide('share-modal');
  document.body.style.overflow = '';
}

async function copyShareUrl() {
  const url = $('share-url-input').value;
  await copyToClipboard(url);
  showToast('링크가 클립보드에 복사되었습니다');
  closeShareModal();
}

function shareKakao() {
  const url = $('share-url-input').value;
  window.location.href = `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
  setTimeout(() => closeShareModal(), 500);
}

function shareSMS() {
  const url = $('share-url-input').value;
  const body = `ByeTax 분석 결과를 확인해 보세요: ${url}`;
  const sep = /iPhone|iPad/i.test(navigator.userAgent) ? '&' : '?';
  window.location.href = `sms:${sep}body=${encodeURIComponent(body)}`;
  setTimeout(() => closeShareModal(), 500);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement('input');
    el.value = text;
    el.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  }
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.className   = 'toast toast-in';
  clearTimeout(t._tid);
  t._tid = setTimeout(() => {
    t.classList.replace('toast-in', 'toast-out');
    setTimeout(() => { t.className = 'toast hidden'; }, 300);
  }, 2200);
}

/* ── 공유 모드 (읽기 전용) ──────────────────────────────────────── */
async function enterShareMode(token) {
  document.body.classList.add('share-mode');
  show('share-banner');
  hide('upload-section');
  show('loading');
  setHeaderState('share');

  try {
    const res = await fetch(`${API}/share/${token}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      hide('loading');
      show('share-error');
      $('share-error-msg').textContent = err.detail || '유효하지 않은 공유 링크';
      return;
    }
    const data = await res.json();
    hide('loading');

    currentTaxpayerId = data.id;
    renderResult(data, data.id);
    show('result-section');
    loadCalc(data.id, '');
    loadAI(data.id, '');

  } catch {
    hide('loading');
    show('share-error');
    $('share-error-msg').textContent = '서버와 연결할 수 없습니다.';
  }
}

/* ── 엑셀 다운로드 ───────────────────────────────────────────────── */
async function downloadExcel() {
  if (!currentTaxpayerId) return;
  downloadExcelById(currentTaxpayerId);
}

async function downloadExcelById(id) {
  if (!id) return;
  try {
    const res = await authFetch(`${API}/taxpayers/${id}/export/excel`);
    if (!res.ok) throw new Error('다운로드 실패');
    const blob  = await res.blob();
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    const cd    = res.headers.get('content-disposition') || '';
    const match = cd.match(/filename\*=UTF-8''(.+)/);
    a.href     = url;
    a.download = match ? decodeURIComponent(match[1]) : `ByeTax_${id}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('엑셀 다운로드 오류: ' + err.message);
  }
}

/* ── 이력 탭 ─────────────────────────────────────────────────────── */
async function loadHistory() {
  hide('history-empty');
  hide('history-detail');
  hide('history-list');
  show('history-loading');
  $('history-list').innerHTML = '';

  try {
    const res  = await authFetch(`${API}/taxpayers`);
    const list = await res.json();
    hide('history-loading');

    if (!list.length) { show('history-empty'); return; }
    show('history-list');

    $('history-list').innerHTML = list.map(tp => {
      const biz = tp.guide_type ? tp.guide_type.split(',')[0] : '';
      const dt  = (tp.uploaded_at || '').replace('T', ' ').slice(0, 16);
      return `
        <div class="hist-card" onclick="openHistoryDetail(${tp.id})">
          <div class="hist-card-top">
            <div class="hist-name">${tp.name || '-'}</div>
            <div class="hist-year-badge">${tp.tax_year || '-'}귀속</div>
          </div>
          <div class="hist-guide">${biz || '-'}</div>
          <div class="hist-footer">
            <span class="hist-dt">${dt}</span>
            <span class="hist-file">${tp.pdf_filename || '-'}</span>
          </div>
          <button class="btn-detail">상세 보기</button>
        </div>`;
    }).join('');

  } catch {
    hide('history-loading');
    show('history-empty');
  }
}

async function openHistoryDetail(id) {
  currentHistId = id;
  hide('history-list');
  show('history-loading');

  try {
    const res  = await authFetch(`${API}/taxpayers/${id}`);
    const data = await res.json();
    hide('history-loading');
    show('history-detail');

    renderResult(data, id, '-h');
    loadCalc(id, '-h');
    loadAI(id,  '-h');

    setHeaderState('detail');
    showActionBar('history');
    window.scrollTo({ top: 0, behavior: 'smooth' });

  } catch {
    hide('history-loading');
    show('history-list');
    alert('데이터 로드 실패');
  }
}

function closeHistoryDetail() {
  hide('history-detail');
  show('history-list');
  currentHistId = null;
  setHeaderState('default');
  hideActionBar();
}

/* ── 페이지 로드 시 인증 초기화 ────────────────────────────────── */
initAuth();
