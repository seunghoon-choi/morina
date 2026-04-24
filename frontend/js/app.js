'use strict';

/* ══════════════════════════════════════════════════════════════════
   ByeTax Mobile SPA · v0.3
   · 해시 라우팅 (#/path)
   · 하단 탭 네비게이션
   · 1분 기초검진 (현 MVP PDF 업로드 기반)
   ══════════════════════════════════════════════════════════════════ */

const API = '';
let currentTaxpayerId = null;   // 현재 진단 리포트의 taxpayer id
let _currentRoute = '/';

/* ── 유틸 ───────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const fmt    = (n, unit='원') => n == null ? '-' : Number(n).toLocaleString('ko-KR') + unit;
const fmtPct = v => v == null ? '-' : Number(v).toFixed(2) + '%';
function show(id) { const el = $(id); if (el) el.classList.remove('hidden'); }
function hide(id) { const el = $(id); if (el) el.classList.add('hidden'); }

function showToast(msg, duration = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), duration);
}

/* ══════════════════════════════════════════════════════════════════
   인증
   ══════════════════════════════════════════════════════════════════ */
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

async function initAuth() {
  // OAuth 콜백으로 ?token= 파라미터 수신 시 저장
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem('byetax_token', urlToken);
    params.delete('token');
    const qs = params.toString();
    history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
  }

  // 공유 모드 — 인증 불필요
  const shareToken = new URLSearchParams(window.location.search).get('share');
  if (shareToken) {
    hide('login-screen');
    hide('onboarding-screen');
    enterShareMode(shareToken);
    return;
  }

  // 기본 login-screen은 숨김 (가입/로그인은 Paywall에서만 발생)
  hide('login-screen');

  // 기존 토큰으로 세션 검증
  const token = localStorage.getItem('byetax_token');
  if (token) {
    hide('onboarding-screen');
    try {
      const res = await fetch(`${API}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const user = await res.json();
        updateUserArea(user);
        return true;
      }
    } catch {}
    localStorage.removeItem('byetax_token');
  }

  // 토큰 없음 — 첫 방문이면 온보딩 표시, 본 적 있으면 silent session 자동 발급 후 홈
  if (!hasSeenOnboarding()) {
    show('onboarding-screen');
    return false;   // 온보딩 완료 시점에 세션 발급
  }

  // 온보딩 봤는데 토큰이 사라진 경우 (로그아웃 등): 다시 silent 세션 발급 후 홈
  await ensureAnonymousSession();
  return true;
}

function updateUserArea(user) {
  if (!user) return;
  // 내정보 탭에 유저 정보 주입
  const nickname = user.nickname || '사장님';
  $('me-name').textContent = nickname + ' 사장님';
  $('me-avatar-initial').textContent = nickname.charAt(0);
  const avatar = $('me-avatar-img');
  if (user.profile_image) {
    avatar.src = user.profile_image;
    avatar.style.display = 'block';
  }
  // 홈 인사
  const hi = $('hero-greeting');
  if (hi) hi.textContent = `안녕하세요, ${nickname} 사장님! 👋`;
}

function kakaoLogin() {
  // 미완성 상태 유지
  showToast('카카오 로그인은 준비 중이에요. 개발용 로그인으로 진행해 주세요.');
}

async function devLogin() {
  try {
    const res  = await fetch(`${API}/auth/dev-login?nickname=테스트사용자`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '로그인 실패');
    localStorage.setItem('byetax_token', data.access_token);
    fadeOutOverlay('login-screen');
    updateUserArea({ nickname: data.nickname, profile_image: '' });
    route('/');
  } catch (err) {
    showToast('로그인 실패: ' + err.message);
  }
}

function fadeOutOverlay(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('fade-out');
  }, 400);
}

function logout() {
  // 토큰만 제거 — 새로고침 시 ensureAnonymousSession이 다시 발급
  localStorage.removeItem('byetax_token');
  location.reload();
}


/* ══════════════════════════════════════════════════════════════════
   라우팅
   ══════════════════════════════════════════════════════════════════ */

/** 라우트별 페이지 설정
 * id          : 화면 섹션 DOM id
 * title       : 헤더에 표시할 타이틀 (null이면 로고 표시)
 * showBack    : 뒤로가기 버튼 표시 여부
 * navKey      : 하단 탭 활성화 대상 (null이면 탭 비활성)
 * onEnter     : 진입 시 호출할 콜백
 */
const ROUTES = {
  '/'                   : { id: 'page-home',              title: null,              showBack: false, navKey: '/',          onEnter: enterHome },
  '/diagnosis'          : { id: 'page-diagnosis',         title: '세무 진단',          showBack: false, navKey: '/diagnosis', onEnter: null },
  '/quick-check'        : { id: 'page-quick-check',       title: '1분 세무기초검진',   showBack: true,  navKey: '/diagnosis', onEnter: enterQuickCheck },
  '/result'             : { id: 'page-result',            title: '진단 리포트',        showBack: true,  navKey: '/diagnosis', onEnter: null },
  '/deep-care'          : { id: 'page-deep-care',         title: '세무 밀착관리',      showBack: true,  navKey: '/diagnosis', onEnter: null },
  '/withholding'        : { id: 'page-withholding',       title: '인건비·원천세',      showBack: true,  navKey: '/diagnosis', onEnter: null },
  '/diagnosis-history'  : { id: 'page-diagnosis-history', title: '진단 내역',          showBack: true,  navKey: '/diagnosis', onEnter: loadHistory },
  '/vault'              : { id: 'page-vault',             title: '보관함',             showBack: false, navKey: '/vault',     onEnter: null },
  '/calendar'           : { id: 'page-calendar',          title: '세무 캘린더',        showBack: false, navKey: '/calendar',  onEnter: null },
  '/me'                 : { id: 'page-me',                title: '내정보',             showBack: false, navKey: '/me',        onEnter: null },
};

function route(path) {
  // 해시 업데이트 → 리스너가 렌더링
  if ('#' + path === location.hash) {
    renderRoute(path);   // 동일 해시여도 재렌더
  } else {
    location.hash = '#' + path;
  }
}

function renderRoute(path) {
  const cfg = ROUTES[path] || ROUTES['/'];
  _currentRoute = path;

  // 모든 page 숨김
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));

  // 해당 page 표시
  const target = document.getElementById(cfg.id);
  if (target) target.classList.remove('hidden');

  // 헤더 타이틀/뒤로가기
  const titleEl = $('header-page-title');
  const logoEl  = $('logo-area');
  const backEl  = $('btn-header-back');
  if (cfg.title) {
    titleEl.textContent = cfg.title;
    titleEl.classList.remove('hidden');
    logoEl.style.display = 'none';
  } else {
    titleEl.classList.add('hidden');
    logoEl.style.display = '';
  }
  if (cfg.showBack) backEl.classList.remove('hidden');
  else backEl.classList.add('hidden');

  // 하단 탭 활성화
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === cfg.navKey);
  });

  // 스크롤 top
  window.scrollTo(0, 0);

  // 진입 콜백
  if (typeof cfg.onEnter === 'function') cfg.onEnter();
}

function goBack() {
  if (history.length > 1) history.back();
  else route('/');
}

/* ── 해시 변경 감지 ─────────────────────────────────────────────── */
window.addEventListener('hashchange', () => {
  const path = location.hash.replace(/^#/, '') || '/';
  renderRoute(path);
});

/* ══════════════════════════════════════════════════════════════════
   [/] 홈 진입
   ══════════════════════════════════════════════════════════════════ */
async function enterHome() {
  // 세무건강도는 현재 목업. 실제 구현 시 /api/health-score 엔드포인트 연동 예정.
  try {
    const res = await authFetch(`${API}/taxpayers`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        // 최신 진단 데이터가 있으면 점수 반영 (목업: 85점)
        updateHealthScore(85);
      }
    }
  } catch {}
}

/* 개발용: 전체 플래그 리셋 (브라우저 콘솔에서 호출) */
window.resetByeTax = function () {
  localStorage.clear();
  location.reload();
};

function updateHealthScore(score) {
  const num = $('health-score-num');
  const bar = $('health-bar-fill');
  const badge = $('health-badge');
  if (!num) return;
  num.textContent = score;
  bar.style.width = Math.min(100, score) + '%';

  if (score >= 80) {
    badge.textContent = '안전';
    badge.className = 'health-badge safe';
  } else if (score >= 50) {
    badge.textContent = '주의';
    badge.className = 'health-badge';
  } else {
    badge.textContent = '위험';
    badge.className = 'health-badge danger';
  }
}


/* ══════════════════════════════════════════════════════════════════
   [/quick-check] 1분 기초검진 — PDF 업로드
   ══════════════════════════════════════════════════════════════════ */
function enterQuickCheck() {
  // 진입 시 상태 초기화 (뒤로갔다 다시 오는 경우 대비)
  resetQuickCheck();
}

function resetQuickCheck() {
  hide('loading');
  hide('error-box');
  hide('file-info');
  hide('btn-analyze');
  const input = $('pdf-input');
  if (input) input.value = '';
  const dz = $('drop-zone');
  if (dz) dz.classList.remove('hidden');
}

function clearFile() {
  $('pdf-input').value = '';
  hide('file-info');
  hide('btn-analyze');
}

/* 드래그&드롭 / 파일 선택 이벤트 바인딩 (한 번만) */
let _dropzoneBound = false;
function bindQuickCheckDropzone() {
  if (_dropzoneBound) return;
  const dz = $('drop-zone');
  const input = $('pdf-input');
  if (!dz || !input) return;

  input.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleFileSelected(f);
  });

  ['dragenter', 'dragover'].forEach(ev => {
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag-over'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag-over'); });
  });
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.pdf')) {
      input.files = e.dataTransfer.files;
      handleFileSelected(f);
    } else {
      showToast('PDF 파일만 업로드 가능합니다');
    }
  });
  _dropzoneBound = true;
}

function handleFileSelected(f) {
  $('file-name-text').textContent = f.name;
  show('file-info');
  show('btn-analyze');
}

async function uploadPDF() {
  const input = $('pdf-input');
  const file = input.files[0];
  if (!file) return;

  hide('error-box');
  hide('file-info');
  hide('btn-analyze');
  show('loading');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await authFetch(`${API}/upload`, { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '업로드 실패');

    currentTaxpayerId = data.taxpayer_id;
    hide('loading');
    // 리포트 페이지로 이동
    route('/result');
    // 데이터 렌더
    await renderTaxpayerResult(data.taxpayer_id);

  } catch (err) {
    hide('loading');
    $('error-msg').textContent = err.message || '오류가 발생했습니다';
    show('error-box');
  }
}


/* ══════════════════════════════════════════════════════════════════
   [/result] 진단 리포트 렌더
   ══════════════════════════════════════════════════════════════════ */
async function renderTaxpayerResult(taxpayerId) {
  try {
    const res = await authFetch(`${API}/taxpayers/${taxpayerId}`);
    if (!res.ok) throw new Error('데이터 조회 실패');
    const data = await res.json();
    renderTaxpayerInfo(data.taxpayer);
    renderBusinesses(data.businesses || []);
    renderHistory(data.tax_history || []);
    // 점수 (목업 85, 데이터에 따라 계산 로직 추후 추가)
    animateScore(85);
    renderSeviMessage(85);
    // AI + 세금 계산 동시 로딩
    loadAIAnalysis(taxpayerId);
    loadTaxCalc(taxpayerId);
  } catch (err) {
    showToast('데이터를 불러오지 못했습니다');
  }
}

function animateScore(score) {
  const num = $('score-num');
  const ring = $('score-ring-fg');
  if (!num || !ring) return;
  num.textContent = score;
  // 원주 = 2π × 52 ≈ 326.7
  const circumference = 326.7;
  const offset = circumference * (1 - score / 100);
  ring.style.strokeDashoffset = offset;
}

function renderSeviMessage(score) {
  const msg = $('report-sevi-msg');
  if (!msg) return;
  if (score >= 90) msg.textContent = '아주 건강해요! 이대로 유지하시면 됩니다.';
  else if (score >= 80) msg.textContent = '전반적으로 양호해요! 몇 가지만 챙기면 완벽합니다.';
  else if (score >= 60) msg.textContent = '몇 가지 주의할 포인트가 보여요. 세비랑 같이 개선해요!';
  else msg.textContent = '지금 바로 점검이 필요해요. 세무사 상담을 권장 드려요.';
}

function renderTaxpayerInfo(t) {
  if (!t) return;
  const grid = $('card-taxpayer');
  grid.innerHTML = '';
  const pairs = [
    ['성명', t.name],
    ['주민등록번호', t.resident_number],
    ['전화번호', t.phone],
    ['주소', t.address],
    ['신고유형', t.filing_type],
    ['기장의무', t.bookkeeping_duty],
  ];
  pairs.forEach(([k, v]) => {
    const div = document.createElement('div');
    div.innerHTML = `<span class="info-k">${k}</span><span class="info-v">${v || '-'}</span>`;
    grid.appendChild(div);
  });
}

function renderBusinesses(list) {
  const tbody = $('tbody-businesses');
  const badge = $('biz-total-badge');
  if (!tbody) return;
  tbody.innerHTML = '';
  let total = 0;
  list.forEach(b => {
    total += Number(b.income_amount) || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="사업자번호">${b.biz_number || '-'}</td>
      <td data-label="상호">${b.biz_name || '-'}</td>
      <td data-label="수입종류">${b.income_type || '-'}</td>
      <td data-label="업종코드">${b.industry_code || '-'}</td>
      <td data-label="사업형태">${b.business_type || '-'}</td>
      <td data-label="경비율">${b.expense_rate || '-'}</td>
      <td class="num" data-label="수입금액">${fmt(b.income_amount)}</td>
      <td class="num" data-label="기준경비율(일반)">${fmtPct(b.base_expense_rate_general)}</td>
      <td class="num" data-label="단순경비율(일반)">${fmtPct(b.simple_expense_rate_general)}</td>
    `;
    tbody.appendChild(tr);
  });
  if (badge) badge.textContent = '합계 ' + fmt(total);
}

function renderHistory(list) {
  const tbody = $('tbody-history');
  if (!tbody || list.length === 0) return;
  tbody.innerHTML = '';
  const years = list.map(h => h.year);
  if (years[0] != null) $('yr-0').textContent = years[0] + '년';
  if (years[1] != null) $('yr-1').textContent = years[1] + '년';
  if (years[2] != null) $('yr-2').textContent = years[2] + '년';

  const rows = [
    ['수입금액', 'income_amount'],
    ['소득금액', 'income'],
    ['산출세액', 'calculated_tax'],
    ['결정세액', 'determined_tax'],
    ['납부세액', 'paid_tax'],
  ];
  rows.forEach(([label, key]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${label}</td>
      <td class="num">${list[0] && list[0][key] != null ? fmt(list[0][key], '') : '-'}</td>
      <td class="num">${list[1] && list[1][key] != null ? fmt(list[1][key], '') : '-'}</td>
      <td class="num">${list[2] && list[2][key] != null ? fmt(list[2][key], '') : '-'}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function loadAIAnalysis(taxpayerId) {
  const loading = $('ai-loading');
  const commentsEl = $('ai-comments');
  const noteEl = $('ai-note');
  const badge = $('ai-risk-badge');

  loading.style.display = 'flex';
  commentsEl.innerHTML = '';
  noteEl.innerHTML = '';

  try {
    const res = await authFetch(`${API}/taxpayers/${taxpayerId}/ai-analysis`);
    if (!res.ok) throw new Error('분석 실패');
    const data = await res.json();

    loading.style.display = 'none';

    if (data.risk_level) {
      badge.textContent = data.risk_level === 'high' ? '위험'
                       : data.risk_level === 'medium' ? '주의' : '안전';
      badge.className = 'risk-badge risk-' + data.risk_level;
      badge.classList.remove('hidden');
    }
    (data.comments || []).forEach(c => {
      const row = document.createElement('div');
      row.className = 'ai-comment-row';
      row.textContent = c;
      commentsEl.appendChild(row);
    });
    if (data.note) noteEl.textContent = data.note;
  } catch {
    loading.style.display = 'none';
    commentsEl.innerHTML = '<div class="ai-comment-row">AI 분석을 불러오지 못했습니다.</div>';
  }
}

async function loadTaxCalc(taxpayerId) {
  const loading = $('calc-loading');
  const steps = $('calc-steps');
  loading.style.display = 'flex';
  steps.innerHTML = '';

  try {
    const res = await authFetch(`${API}/taxpayers/${taxpayerId}/calculate`);
    if (!res.ok) throw new Error('계산 실패');
    const data = await res.json();
    loading.style.display = 'none';

    const rows = [
      ['종합소득금액',    data.total_income],
      ['소득공제',        data.income_deduction ? '-' + fmt(data.income_deduction).replace('원','') : null],
      ['과세표준',        data.tax_base],
      ['산출세액',        data.calculated_tax],
      ['세액공제',        data.tax_credit ? '-' + fmt(data.tax_credit).replace('원','') : null],
      ['결정세액',        data.determined_tax],
      ['가산세',          data.penalty],
      ['기납부세액',      data.prepaid_tax ? '-' + fmt(data.prepaid_tax).replace('원','') : null],
    ];
    rows.forEach(([label, val]) => {
      if (val == null || val === 0) return;
      const row = document.createElement('div');
      row.className = 'calc-row';
      row.innerHTML = `<span class="calc-label">${label}</span><span class="calc-value">${typeof val === 'string' ? val + '원' : fmt(val)}</span>`;
      steps.appendChild(row);
    });
    // 총 납부세액
    const final = data.final_tax != null ? data.final_tax : 0;
    const total = document.createElement('div');
    total.className = 'calc-row total';
    total.innerHTML = `<span>납부할 세액</span><span>${fmt(final)}</span>`;
    steps.appendChild(total);
  } catch {
    loading.style.display = 'none';
    steps.innerHTML = '<div class="calc-row"><span>계산 결과를 불러오지 못했습니다.</span></div>';
  }
}


/* ══════════════════════════════════════════════════════════════════
   [/diagnosis-history] 진단 내역
   ══════════════════════════════════════════════════════════════════ */
async function loadHistory() {
  const container = $('history-list');
  if (!container) return;
  try {
    const res = await authFetch(`${API}/taxpayers`);
    if (!res.ok) throw new Error();
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      // 이미 empty state 있음
      return;
    }
    container.innerHTML = '';
    list.forEach(item => {
      const div = document.createElement('div');
      div.className = 'diag-item';
      div.style.marginBottom = '8px';
      div.onclick = () => {
        currentTaxpayerId = item.id;
        route('/result');
        renderTaxpayerResult(item.id);
      };
      const date = item.created_at ? item.created_at.slice(0, 10) : '';
      div.innerHTML = `
        <div class="diag-item-icon bg-primary-l">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#5B6CF9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6"/>
          </svg>
        </div>
        <div class="diag-item-body">
          <div class="diag-item-title">${item.name || '기초검진'}</div>
          <div class="diag-item-desc">${date} · ${item.filing_type || '-'}</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#CBD5E1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 5l5 5-5 5"/>
        </svg>
      `;
      container.appendChild(div);
    });
  } catch {
    /* 비어있는 상태 유지 */
  }
}


/* ══════════════════════════════════════════════════════════════════
   공유 모드 (?share=TOKEN)
   ══════════════════════════════════════════════════════════════════ */
async function enterShareMode(token) {
  show('share-banner');
  // 하단 탭 + 헤더 액션 숨김
  document.body.classList.add('share-mode');
  $('bottom-nav').style.display = 'none';
  const bell = $('btn-bell');
  if (bell) bell.style.display = 'none';

  try {
    const res = await fetch(`${API}/share/${token}`);
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.detail || '링크를 불러올 수 없습니다');
    }
    const data = await res.json();
    // 리포트 영역으로 바로 진입
    hide('page-home');
    show('page-result');
    $('header-page-title').textContent = '진단 리포트 (공유)';
    $('header-page-title').classList.remove('hidden');
    $('logo-area').style.display = 'none';

    renderTaxpayerInfo(data.taxpayer);
    renderBusinesses(data.businesses || []);
    renderHistory(data.tax_history || []);
    animateScore(85);
    renderSeviMessage(85);
    // 공유 모드에서는 AI/계산도 백엔드에 따라 결정 (여기선 스킵)
  } catch (err) {
    hide('page-home');
    show('share-error');
    $('share-error-msg').textContent = err.message;
  }
}


/* ══════════════════════════════════════════════════════════════════
   온보딩 (3 슬라이드)
   ══════════════════════════════════════════════════════════════════ */
const ONBOARDING_FLAG = 'byetax_onboarded';

let _onboardingIdx = 0;

function hasSeenOnboarding() {
  return localStorage.getItem(ONBOARDING_FLAG) === '1';
}
function markOnboardingDone() {
  localStorage.setItem(ONBOARDING_FLAG, '1');
}

function moveOnboarding(idx) {
  _onboardingIdx = Math.max(0, Math.min(2, idx));
  const track = $('onboarding-track');
  if (track) track.style.transform = `translateX(-${_onboardingIdx * 33.3333}%)`;

  document.querySelectorAll('.onboarding-dots .dot').forEach((d, i) => {
    d.classList.toggle('active', i === _onboardingIdx);
  });

  const btn = $('btn-onboarding-next');
  if (btn) btn.textContent = _onboardingIdx === 2 ? '시작하기' : '다음';
}

function nextOnboardingSlide() {
  if (_onboardingIdx < 2) {
    moveOnboarding(_onboardingIdx + 1);
  } else {
    finishOnboarding();
  }
}

function skipOnboarding() {
  finishOnboarding();
}

/**
 * 온보딩 완료 시: 로그인 없이도 홈으로 진입할 수 있게
 * 백그라운드에서 익명 세션을 자동 발급 (silent auto-login)
 * — 기초검진까지는 회원가입 체감 없이 사용 가능
 * — 밀착관리/원천세/보관함 클릭 시에만 Paywall 오버레이 노출
 */
async function finishOnboarding() {
  markOnboardingDone();
  fadeOutOverlay('onboarding-screen');

  // 홈 진입 전 silent 세션 발급
  await ensureAnonymousSession();
  setTimeout(() => route('/'), 400);
}

async function ensureAnonymousSession() {
  if (localStorage.getItem('byetax_token')) return true;
  try {
    const res = await fetch(`${API}/auth/dev-login?nickname=사장님`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || '세션 발급 실패');
    localStorage.setItem('byetax_token', data.access_token);
    updateUserArea({ nickname: data.nickname, profile_image: '' });
    return true;
  } catch (err) {
    console.warn('[ByeTax] silent session 발급 실패:', err.message);
    return false;
  }
}

// 닷 클릭으로 슬라이드 이동
document.addEventListener('click', e => {
  const dot = e.target.closest('.onboarding-dots .dot');
  if (dot) {
    const idx = Number(dot.dataset.index || 0);
    moveOnboarding(idx);
  }
});


/* ══════════════════════════════════════════════════════════════════
   업종/지역 라벨 (홈 세무팁 표시용으로만 유지)
   ══════════════════════════════════════════════════════════════════ */
const INDUSTRY_LABEL = {
  food: '음식점업', retail: '도소매업', service: '서비스업',
  ecommerce: '전자상거래', transport: '운수업',
  education: '교육·프리랜서', other: '기타',
};


/* ══════════════════════════════════════════════════════════════════
   Paywall 오버레이 (밀착관리/원천세/보관함)
   ══════════════════════════════════════════════════════════════════ */
const PAYWALL_COPY = {
  'deep-care': {
    title: '세무 밀착관리는 회원 전용이에요',
    desc: '카카오로 가입하면<br/><b>매출·매입·경비 종합 관리</b>까지 가능해요',
  },
  'withholding': {
    title: '원천세 신고 가이드는 회원 전용이에요',
    desc: '카카오로 가입하면<br/><b>직원 등록·원천세·홈택스 제출</b>까지 연결돼요',
  },
  'vault': {
    title: '자료 보관함은 회원 전용이에요',
    desc: '카카오로 가입하면<br/><b>5년간 증빙을 안전하게</b> 보관할 수 있어요',
  },
};

function openPaywall(key) {
  const copy = PAYWALL_COPY[key] || PAYWALL_COPY['deep-care'];
  $('paywall-title').textContent = copy.title;
  $('paywall-desc').innerHTML = copy.desc;
  $('paywall-overlay').classList.remove('hidden');
}

function closePaywall(ev) {
  if (ev && ev.target && ev.target.id !== 'paywall-overlay' && !ev.target.closest('.paywall-close')) return;
  $('paywall-overlay').classList.add('hidden');
}
// Ensure close button works even without event param
function _closePaywallDirect() { $('paywall-overlay').classList.add('hidden'); }

function kakaoLoginFromPaywall() {
  // TODO: 실제 카카오 OAuth 연동. 지금은 안내만 표시.
  showToast('카카오 로그인은 곧 오픈됩니다. 현재는 무료 기초검진만 이용 가능해요.');
  _closePaywallDirect();
}


/* ══════════════════════════════════════════════════════════════════
   스플래시 화면 처리
   ══════════════════════════════════════════════════════════════════ */
const SPLASH_MIN_DURATION = 1800;   // 최소 1.8초 노출
const SPLASH_FADE_MS      = 450;

function dismissSplash() {
  const el = $('splash-screen');
  if (!el || el.classList.contains('fade-out')) return;
  el.classList.add('fade-out');
  setTimeout(() => { el.style.display = 'none'; }, SPLASH_FADE_MS);
}

function scheduleSplashDismiss(startedAt) {
  // 공유 모드 등에서 빠른 접근 필요한 경우엔 즉시 dismiss
  const shareToken = new URLSearchParams(window.location.search).get('share');
  if (shareToken) {
    dismissSplash();
    return;
  }
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, SPLASH_MIN_DURATION - elapsed);
  setTimeout(dismissSplash, remaining);
}


/* ══════════════════════════════════════════════════════════════════
   초기화
   ══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const splashStartedAt = Date.now();

  // 드롭존 이벤트 바인딩
  bindQuickCheckDropzone();

  // 인증 + 첫 라우트 렌더 (스플래시 뒤에서 미리 준비)
  const ok = await initAuth();
  if (ok !== false) {
    const initial = location.hash.replace(/^#/, '') || '/';
    renderRoute(initial);
  }

  // 최소 노출시간 보장하고 스플래시 dismiss
  scheduleSplashDismiss(splashStartedAt);
});
