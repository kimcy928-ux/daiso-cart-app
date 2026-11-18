(() => {
  'use strict';

  const STORAGE_KEY = 'daiso-cart-v1';
  const CHECK_DELAY_MS = 2000;
  const UNDO_WINDOW_MS = 5000;
  const POLL_INTERVAL_MS = 4000;
  const SYNC_DEBOUNCE_MS = 300;

  /** @typedef {{id:string,pdNo:string,name:string,price:number,image:string|null,qty:number,checked:boolean,manual:boolean}} CartItem */

  // ---------- 공유 모드(친구와 같이 쓰기) 상태 ----------
  // URL에 ?room=CODE 가 있으면 "공유 모드": 서버(/api/cart)에 저장된 리스트를
  // 몇 초마다 동기화합니다. 없으면 "혼자 모드": 지금까지처럼 이 휴대폰에만 저장됩니다.
  let mode = 'solo'; // 'solo' | 'shared'
  let roomCode = null;

  (function detectRoom() {
    const param = (new URLSearchParams(location.search).get('room') || '').trim();
    if (/^[A-Za-z0-9]{4,12}$/.test(param)) {
      mode = 'shared';
      roomCode = param.toUpperCase();
    }
  })();

  function storageKeyForMode() {
    return mode === 'shared' ? `daiso-cart-shared-${roomCode}` : STORAGE_KEY;
  }

  /** @type {CartItem[]} */
  let cart = loadCart();
  let pendingTimers = new Map(); // id -> timeout id (체크 후 삭제 대기)
  let lastRemoved = null; // {item, index} 되돌리기용
  let undoTimer = null;
  let pollTimer = null;
  let syncDebounce = null;

  // ---------- storage ----------
  function loadCart() {
    try {
      const raw = localStorage.getItem(storageKeyForMode());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function cacheLocally() {
    try {
      localStorage.setItem(storageKeyForMode(), JSON.stringify(cart));
    } catch {
      /* 저장 용량 초과 등은 조용히 무시 */
    }
  }

  function persist() {
    cacheLocally();
    if (mode === 'shared') scheduleSync();
  }

  // ---------- helpers ----------
  function won(n) {
    return `${Number(n || 0).toLocaleString('ko-KR')}원`;
  }

  function uid(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function genRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I 제외
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // ---------- DOM refs ----------
  const els = {
    searchForm: document.getElementById('searchForm'),
    searchInput: document.getElementById('searchInput'),
    searchResults: document.getElementById('searchResults'),
    manualFallback: document.getElementById('manualFallback'),
    manualMsg: document.getElementById('manualMsg'),
    manualForm: document.getElementById('manualForm'),
    manualName: document.getElementById('manualName'),
    manualPrice: document.getElementById('manualPrice'),
    manualToggle: document.getElementById('manualToggle'),
    cartList: document.getElementById('cartList'),
    emptyState: document.getElementById('emptyState'),
    totalbar: document.getElementById('totalbar'),
    totalPrice: document.getElementById('totalPrice'),
    shareBtn: document.getElementById('shareBtn'),
    clearBtn: document.getElementById('clearBtn'),
    snackbar: document.getElementById('snackbar'),
    snackbarMsg: document.getElementById('snackbarMsg'),
    undoBtn: document.getElementById('undoBtn'),
    shareRoomBtn: document.getElementById('shareRoomBtn'),
    sharedBadge: document.getElementById('sharedBadge'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn'),
  };

  // ---------- cart rendering ----------
  function render(skipPersist) {
    if (skipPersist) {
      cacheLocally();
    } else {
      persist();
    }

    if (cart.length === 0) {
      els.emptyState.classList.remove('hidden');
      els.cartList.innerHTML = '';
      els.totalbar.classList.add('hidden');
      return;
    }

    els.emptyState.classList.add('hidden');
    els.totalbar.classList.remove('hidden');

    els.cartList.innerHTML = cart.map(renderItem).join('');

    const total = cart
      .filter((i) => !i.checked)
      .reduce((sum, i) => sum + i.price * i.qty, 0);
    els.totalPrice.textContent = won(total);

    bindItemEvents();
  }

  function renderItem(item) {
    const thumb = item.image
      ? `<img class="ci-thumb" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;ci-thumb placeholder&quot;>🧺</div>'" />`
      : `<div class="ci-thumb placeholder">🧺</div>`;

    return `
      <li class="cart-item ${item.checked ? 'checked' : ''}" data-id="${item.id}">
        <input type="checkbox" class="ci-check" ${item.checked ? 'checked' : ''} aria-label="구매완료 체크" />
        ${thumb}
        <div class="ci-info">
          <div class="ci-name">${escapeHtml(item.name)}</div>
          <div class="ci-meta">${item.manual ? '직접입력' : `품번 ${escapeHtml(item.pdNo)}`}</div>
          <div class="ci-price">${won(item.price)}</div>
          <div class="ci-qty">
            <button type="button" class="qty-btn" data-action="dec">−</button>
            <span class="qty-val">${item.qty}</span>
            <button type="button" class="qty-btn" data-action="inc">+</button>
          </div>
        </div>
        <button type="button" class="ci-remove" aria-label="삭제">🗑</button>
      </li>
    `;
  }

  function bindItemEvents() {
    els.cartList.querySelectorAll('.cart-item').forEach((li) => {
      const id = li.dataset.id;

      li.querySelector('.ci-check').addEventListener('change', (e) => {
        onToggleCheck(id, e.target.checked);
      });

      li.querySelectorAll('.qty-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          onQtyChange(id, btn.dataset.action === 'inc' ? 1 : -1);
        });
      });

      li.querySelector('.ci-remove').addEventListener('click', () => {
        removeItem(id, true);
      });
    });
  }

  function findItem(id) {
    return cart.find((i) => i.id === id);
  }

  function onQtyChange(id, delta) {
    const item = findItem(id);
    if (!item) return;
    item.qty = Math.max(1, item.qty + delta);
    render();
  }

  function onToggleCheck(id, checked) {
    const item = findItem(id);
    if (!item) return;
    item.checked = checked;
    render();

    if (pendingTimers.has(id)) {
      clearTimeout(pendingTimers.get(id));
      pendingTimers.delete(id);
    }

    if (checked) {
      const t = setTimeout(() => {
        pendingTimers.delete(id);
        removeItem(id, true, true);
      }, CHECK_DELAY_MS);
      pendingTimers.set(id, t);
    }
  }

  function removeItem(id, withUndo, fromPurchase) {
    const idx = cart.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [item] = cart.splice(idx, 1);

    if (pendingTimers.has(id)) {
      clearTimeout(pendingTimers.get(id));
      pendingTimers.delete(id);
    }

    render();

    if (withUndo) {
      lastRemoved = { item, index: idx };
      showSnackbar(
        fromPurchase ? `"${item.name}" 구매완료로 삭제됨` : `"${item.name}" 삭제됨`,
        true
      );
    }
  }

  function undoRemove() {
    if (!lastRemoved) return;
    const { item, index } = lastRemoved;
    item.checked = false;
    const insertAt = Math.min(index, cart.length);
    cart.splice(insertAt, 0, item);
    lastRemoved = null;
    hideSnackbar();
    render();
  }

  // ---------- snackbar ----------
  function showSnackbar(msg, withUndoBtn) {
    els.snackbarMsg.textContent = msg;
    els.snackbar.classList.remove('hidden');
    els.undoBtn.classList.toggle('hidden', !withUndoBtn);
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      lastRemoved = null;
      hideSnackbar();
    }, UNDO_WINDOW_MS);
  }

  function hideSnackbar() {
    els.snackbar.classList.add('hidden');
    if (undoTimer) {
      clearTimeout(undoTimer);
      undoTimer = null;
    }
  }

  els.undoBtn.addEventListener('click', undoRemove);

  // ---------- add to cart ----------
  function addToCart({ pdNo, name, price, image, manual }) {
    const existing = !manual && cart.find((i) => i.pdNo === pdNo && !i.manual);
    if (existing) {
      existing.qty += 1;
    } else {
      cart.unshift({
        id: uid(manual ? 'manual' : 'pd'),
        pdNo: pdNo || null,
        name,
        price: Number(price) || 0,
        image: image || null,
        qty: 1,
        checked: false,
        manual: !!manual,
      });
    }
    render();
  }

  // ---------- search ----------
  let searchAbort = null;
  let searchDebounce = null;

  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    doSearch(els.searchInput.value.trim());
  });

  els.searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    const term = els.searchInput.value.trim();
    if (!term) {
      hideSearchUI();
      return;
    }
    searchDebounce = setTimeout(() => doSearch(term), 450);
  });

  function hideSearchUI() {
    els.searchResults.classList.add('hidden');
    els.manualFallback.classList.add('hidden');
    els.manualToggle.classList.add('hidden');
  }

  async function doSearch(term) {
    if (!term) return;

    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    els.searchResults.classList.remove('hidden');
    els.searchResults.innerHTML = `<div class="search-loading">검색 중…</div>`;
    els.manualFallback.classList.add('hidden');
    els.manualToggle.classList.remove('hidden');

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
        signal: searchAbort.signal,
      });
      const data = await res.json();

      if (!data.ok) {
        showSearchFailure();
        return;
      }

      if (!data.items || data.items.length === 0) {
        els.searchResults.innerHTML = `<div class="search-empty">"${escapeHtml(term)}" 검색 결과가 없어요. 직접 입력해서 담아보세요.</div>`;
        els.manualMsg.textContent = `"${term}"에 대한 결과가 없어요. 이름이랑 가격을 직접 입력해 주세요.`;
        return;
      }

      els.searchResults.innerHTML = data.items.map(renderSearchItem).join('');
      bindSearchResultEvents(data.items);
    } catch (err) {
      if (err.name === 'AbortError') return;
      showSearchFailure();
    }
  }

  function showSearchFailure() {
    els.searchResults.innerHTML = `<div class="search-error">검색을 불러오지 못했어요. 다이소몰 응답이 잠깐 불안정할 수 있어요.</div>`;
    els.manualMsg.textContent = '검색이 안 될 때는 이름이랑 가격을 직접 입력해서 담을 수 있어요.';
    els.manualFallback.classList.remove('hidden');
  }

  function renderSearchItem(item) {
    const thumb = item.image
      ? `<img class="sr-thumb" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
      : `<div class="sr-thumb"></div>`;
    return `
      <div class="search-result-item" data-pdno="${escapeHtml(item.pdNo)}">
        ${thumb}
        <div class="sr-info">
          <div class="sr-name">${escapeHtml(item.name)}</div>
          <div class="sr-meta">품번 ${escapeHtml(item.pdNo)}${item.soldOut ? ' · <span class="sr-soldout">품절표시</span>' : ''}</div>
        </div>
        <div class="sr-price">${won(item.price)}</div>
      </div>
    `;
  }

  function bindSearchResultEvents(items) {
    els.searchResults.querySelectorAll('.search-result-item').forEach((el) => {
      el.addEventListener('click', () => {
        const pdNo = el.dataset.pdno;
        const item = items.find((i) => i.pdNo === pdNo);
        if (!item) return;
        addToCart(item);
        els.searchInput.value = '';
        hideSearchUI();
      });
    });
  }

  els.manualToggle.addEventListener('click', () => {
    els.manualFallback.classList.toggle('hidden');
  });

  els.manualForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.manualName.value.trim();
    const price = Number(els.manualPrice.value);
    if (!name) return;
    addToCart({ pdNo: null, name, price: Number.isFinite(price) ? price : 0, image: null, manual: true });
    els.manualForm.reset();
    els.manualFallback.classList.add('hidden');
    els.manualToggle.classList.add('hidden');
    els.searchResults.classList.add('hidden');
    els.searchInput.value = '';
  });

  // ---------- share as text (카톡에 목록 텍스트로 복사) ----------
  els.shareBtn.addEventListener('click', async () => {
    if (cart.length === 0) return;
    const lines = cart.map((i) => {
      const codePart = i.manual ? '직접입력' : `품번 ${i.pdNo}`;
      return `- ${i.name} x${i.qty} (${won(i.price)}) [${codePart}]`;
    });
    const total = cart.reduce((sum, i) => sum + i.price * i.qty, 0);
    const text = [`🛒 다이소 장바구니`, ...lines, ``, `총 예상금액: ${won(total)}`].join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showSnackbar('목록이 복사됐어요. 카톡에 붙여넣기 하세요!');
      lastRemoved = null; // 공유는 되돌리기 대상이 아님
    } catch {
      // 클립보드 API를 못 쓰는 환경(구형 브라우저 등) 폴백
      window.prompt('아래 내용을 복사하세요:', text);
    }
  });

  els.clearBtn.addEventListener('click', () => {
    if (cart.length === 0) return;
    if (!confirm('장바구니를 전부 비울까요?')) return;
    pendingTimers.forEach((t) => clearTimeout(t));
    pendingTimers.clear();
    cart = [];
    lastRemoved = null;
    hideSnackbar();
    render();
  });

  // ---------- 친구와 같이 쓰기(공유 링크) ----------
  function updateSharedBadge() {
    if (!els.sharedBadge) return;
    if (mode === 'shared') {
      els.sharedBadge.classList.remove('hidden');
      els.shareRoomBtn.classList.add('active');
      els.shareRoomBtn.title = '공유 링크 다시 복사';
    } else {
      els.sharedBadge.classList.add('hidden');
      els.shareRoomBtn.classList.remove('active');
      els.shareRoomBtn.title = '친구랑 같이 쓰기';
    }
  }

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      showSnackbar('공유 링크가 복사됐어요! 카톡으로 친구에게 보내세요');
    } catch {
      window.prompt('이 링크를 복사해서 친구에게 보내세요:', location.href);
    }
  }

  async function startSharing() {
    roomCode = genRoomCode();
    mode = 'shared';
    const url = new URL(location.href);
    url.searchParams.set('room', roomCode);
    history.replaceState(null, '', url);
    updateSharedBadge();
    await pushCartToServer(); // 지금까지 혼자 담았던 목록을 공유방의 시작 목록으로 올림
    startPolling();
    await copyShareLink();
  }

  function leaveSharing() {
    stopPolling();
    mode = 'solo';
    roomCode = null;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    cart = loadCart(); // 혼자 모드 저장분으로 복귀
    updateSharedBadge();
    render(true);
  }

  if (els.shareRoomBtn) {
    els.shareRoomBtn.addEventListener('click', async () => {
      if (mode === 'shared') {
        await copyShareLink();
      } else {
        await startSharing();
      }
    });
  }

  if (els.leaveRoomBtn) {
    els.leaveRoomBtn.addEventListener('click', () => {
      if (confirm('공유를 끄고 내 휴대폰에만 저장되는 목록으로 돌아갈까요?')) {
        leaveSharing();
      }
    });
  }

  // ---------- 서버 동기화 (공유 모드일 때만) ----------
  function scheduleSync() {
    if (mode !== 'shared') return;
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(pushCartToServer, SYNC_DEBOUNCE_MS);
  }

  async function pushCartToServer() {
    if (mode !== 'shared' || !roomCode) return;
    try {
      await fetch(`/api/cart?room=${encodeURIComponent(roomCode)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: cart }),
      });
    } catch {
      // 네트워크 문제는 조용히 무시 — 다음 변경이나 폴링 때 다시 시도됨
    }
  }

  async function fetchSharedCart() {
    if (mode !== 'shared' || !roomCode) return;
    try {
      const res = await fetch(`/api/cart?room=${encodeURIComponent(roomCode)}`);
      const data = await res.json();
      if (!data.ok || !Array.isArray(data.items)) return;

      const incoming = JSON.stringify(data.items);
      if (incoming === JSON.stringify(cart)) return; // 바뀐 게 없으면 다시 그리지 않음

      cart = data.items;
      render(true); // 서버에서 받아온 내용이라 다시 서버로 올리지 않음(skipPersist)
    } catch {
      // 폴링 실패는 조용히 무시, 다음 주기에 재시도
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') fetchSharedCart();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (mode === 'shared' && document.visibilityState === 'visible') fetchSharedCart();
  });

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---------- init ----------
  render(true);

  if (mode === 'shared') {
    updateSharedBadge();
    fetchSharedCart(); // 서버가 갖고 있는 최신 목록으로 덮어씀
    startPolling();
  }
})();
