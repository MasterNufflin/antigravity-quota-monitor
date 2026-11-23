(() => {
  'use strict';

  const BUCKET_RADIUS = 30;
  const BUCKET_CIRC = 2 * Math.PI * BUCKET_RADIUS;
  const MINI_RADIUS = 11;
  const MINI_CIRC = 2 * Math.PI * MINI_RADIUS;
  const DEFAULT_THRESHOLDS = [50, 25, 10, 0];

  const apiFetch = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;

  const state = {
    data: null,
    prefs: {
      notificationsEnabled: true,
      thresholds: [...DEFAULT_THRESHOLDS],
      notifyOnReset: true,
      menuBarEnabled: true,
      pollIntervalSec: 30,
    },
    menuBar: null,
    loading: true,
    inFlight: false,
    pollTimer: null,
    toastTimer: null,
  };

  const els = {
    loading: document.getElementById('loading'),
    app: document.getElementById('app'),
    livePill: document.getElementById('live-pill'),
    liveLabel: document.getElementById('live-label'),
    refreshBtn: document.getElementById('refresh-btn'),
    planBar: document.getElementById('plan-bar'),
    errorBanner: document.getElementById('error-banner'),
    errorMessage: document.getElementById('error-message'),
    retryBtn: document.getElementById('retry-btn'),
    legacyHint: document.getElementById('legacy-hint'),
    updatedAt: document.getElementById('updated-at'),
    poolsGrid: document.getElementById('pools-grid'),
    familiesSection: document.getElementById('families-section'),
    familiesSummary: document.getElementById('families-summary'),
    familiesList: document.getElementById('families-list'),
    unavailableSection: document.getElementById('unavailable-section'),
    unavailableSummary: document.getElementById('unavailable-summary'),
    unavailableList: document.getElementById('unavailable-list'),
    menubarStatus: document.getElementById('menubar-status'),
    prefNotifications: document.getElementById('pref-notifications'),
    prefReset: document.getElementById('pref-reset'),
    prefMenubar: document.getElementById('pref-menubar'),
    thresholdChips: document.getElementById('threshold-chips'),
    intervalChips: document.getElementById('interval-chips'),
    notifyTestBtn: document.getElementById('notify-test-btn'),
    toast: document.getElementById('toast'),
  };

  // ---------- theme ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(() => {
    syncScheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------- helpers ----------
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function requestJson(path, options = {}) {
    const res = await apiFetch(path, options);
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const msg = payload?.error || `${path}: HTTP ${res.status}`;
      throw new Error(msg);
    }
    return payload;
  }

  function getJson(path) {
    return requestJson(path, { method: 'GET' });
  }

  function postJson(path, body) {
    return requestJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  function clampFraction(frac) {
    const n = Number(frac);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function formatPercent(percent, fraction) {
    const p = Number.isFinite(Number(percent))
      ? Number(percent)
      : Math.round(clampFraction(fraction) * 1000) / 10;
    const clamped = Math.max(0, Math.min(100, p));
    return Number.isInteger(clamped) ? `${clamped}%` : `${clamped.toFixed(1)}%`;
  }

  function toneClass(percent) {
    const p = Number(percent) || 0;
    if (p >= 50) return 'tone-ok';
    if (p >= 20) return 'tone-warn';
    return 'tone-crit';
  }

  function formatDuration(resetTime) {
    if (!resetTime) return '—';
    const target = Date.parse(resetTime);
    if (Number.isNaN(target)) return '—';
    const diffSec = Math.floor((target - Date.now()) / 1000);
    if (diffSec <= 0) return 'сброс скоро';

    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    const secs = diffSec % 60;

    if (days > 0) return `${days}д ${hours}ч`;
    if (hours > 0) return `${hours}ч ${mins}м`;
    if (mins > 0) return `${mins}м ${secs}с`;
    return `${secs}с`;
  }

  function formatCountdown(resetTime, untouched, compact = true) {
    if (untouched) return compact ? 'полный' : 'полный лимит';
    const dur = formatDuration(resetTime);
    if (dur === '—' || dur === 'сброс скоро') return dur;
    return compact ? dur : `сброс через ${dur}`;
  }

  function formatResetTooltip(resetTime, untouched) {
    if (untouched) return 'Полный лимит';
    if (!resetTime) return '';
    const d = new Date(resetTime);
    if (Number.isNaN(d.getTime())) return '';
    return `Сброс: ${d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })}`;
  }

  function formatUpdatedAt(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `Обновлено ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  function showToast(message, isError = false) {
    clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', isError);
    els.toast.classList.remove('hidden');
    state.toastTimer = setTimeout(() => {
      els.toast.classList.add('hidden');
    }, 3200);
  }

  function updateCountdowns() {
    const nodes = document.querySelectorAll('[data-reset-time]');
    for (const node of nodes) {
      const resetTime = node.getAttribute('data-reset-time') || '';
      const untouched = node.getAttribute('data-untouched') === 'true';
      const compact = node.getAttribute('data-compact') !== 'false';
      const nextText = formatCountdown(resetTime, untouched, compact);
      if (node.textContent !== nextText) {
        node.textContent = nextText;
      }
      node.classList.toggle('is-untouched', untouched);
    }
  }

  // ---------- rendering ----------
  function setLiveState(mode, label) {
    els.livePill.classList.remove('is-loading', 'is-error');
    if (mode === 'loading') els.livePill.classList.add('is-loading');
    if (mode === 'error') els.livePill.classList.add('is-error');
    els.liveLabel.textContent = label;
  }

  function renderPlan(plan) {
    const parts = [];
    if (plan?.tier) {
      parts.push(`<span class="badge badge-primary">${esc(plan.tier)}</span>`);
    }
    if (plan?.promptCredits !== null && plan?.promptCredits !== undefined) {
      parts.push(`<span class="badge">Prompt: ${esc(plan.promptCredits)}</span>`);
    }
    if (plan?.flowCredits !== null && plan?.flowCredits !== undefined) {
      parts.push(`<span class="badge">Flow: ${esc(plan.flowCredits)}</span>`);
    }
    if (parts.length === 0) {
      els.planBar.classList.add('hidden');
      els.planBar.innerHTML = '';
      return;
    }
    els.planBar.innerHTML = parts.join('');
    els.planBar.classList.remove('hidden');
  }

  function normalizeDisplayGroups(data) {
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    if (groups.length > 0) {
      return {
        isLegacy: false,
        items: groups.map((g) => ({
          id: String(g.id || g.name || ''),
          name: g.name || '',
          buckets: Array.isArray(g.buckets) ? g.buckets : [],
        })),
      };
    }

    const pools = Array.isArray(data?.pools) ? data.pools : [];
    if (pools.length > 0) {
      return {
        isLegacy: true,
        items: pools.map((p) => ({
          id: `legacy-${p.id}`,
          name: p.name || '',
          buckets: [
            {
              id: `legacy-bucket-${p.id}`,
              label: 'Текущий лимит',
              remainingFraction: p.remainingFraction,
              percent: p.percent,
              resetTime: p.resetTime,
              untouched: p.untouched,
            },
          ],
        })),
      };
    }

    return { isLegacy: false, items: [] };
  }

  function renderGroups(data) {
    const { isLegacy, items } = normalizeDisplayGroups(data);
    els.legacyHint.classList.toggle('hidden', !isLegacy);

    if (items.length === 0) {
      els.poolsGrid.innerHTML = '<div class="empty-state">Нет активных пулов квот.</div>';
      return;
    }

    const existingCards = Array.from(els.poolsGrid.querySelectorAll('.pool-card[data-group-id]'));
    const canPatchInPlace =
      existingCards.length === items.length &&
      items.every((group, idx) => {
        const card = existingCards[idx];
        if (card.getAttribute('data-group-id') !== group.id) return false;
        const bucketEls = card.querySelectorAll('.bucket-item[data-bucket-id]');
        if (bucketEls.length !== group.buckets.length) return false;
        return group.buckets.every(
          (b, bIdx) => bucketEls[bIdx].getAttribute('data-bucket-id') === String(b.id)
        );
      });

    if (canPatchInPlace) {
      items.forEach((group, idx) => {
        const card = existingCards[idx];
        const nameEl = card.querySelector('.pool-name');
        if (nameEl) nameEl.textContent = group.name;

        const bucketEls = card.querySelectorAll('.bucket-item[data-bucket-id]');
        group.buckets.forEach((bucket, bIdx) => {
          const el = bucketEls[bIdx];
          const frac = clampFraction(bucket.remainingFraction);
          const pctText = formatPercent(bucket.percent, frac);
          const pctNum = Number.isFinite(Number(bucket.percent)) ? Number(bucket.percent) : frac * 100;
          const tone = toneClass(pctNum);
          const offset = (BUCKET_CIRC * (1 - frac)).toFixed(2);
          const untouched = Boolean(bucket.untouched);
          const tooltip = formatResetTooltip(bucket.resetTime, untouched);

          el.className = `bucket-item ${tone}`;
          const prog = el.querySelector('.ring-progress');
          if (prog) prog.setAttribute('stroke-dashoffset', offset);
          const pctEl = el.querySelector('.ring-pct');
          if (pctEl) pctEl.textContent = pctText;
          const labelEl = el.querySelector('.bucket-label');
          if (labelEl) labelEl.textContent = bucket.label || bucket.shortLabel || '';
          const resetEl = el.querySelector('.bucket-reset');
          if (resetEl) {
            resetEl.setAttribute('data-reset-time', bucket.resetTime || '');
            resetEl.setAttribute('data-untouched', untouched ? 'true' : 'false');
            resetEl.setAttribute('title', tooltip);
            resetEl.classList.toggle('is-untouched', untouched);
            resetEl.textContent = formatCountdown(bucket.resetTime, untouched, true);
          }
        });
      });
      return;
    }

    els.poolsGrid.innerHTML = items
      .map((group) => {
        const bucketsHtml = group.buckets
          .map((bucket) => {
            const frac = clampFraction(bucket.remainingFraction);
            const pctText = formatPercent(bucket.percent, frac);
            const pctNum = Number.isFinite(Number(bucket.percent)) ? Number(bucket.percent) : frac * 100;
            const tone = toneClass(pctNum);
            const offset = (BUCKET_CIRC * (1 - frac)).toFixed(2);
            const untouched = Boolean(bucket.untouched);
            const resetText = formatCountdown(bucket.resetTime, untouched, true);
            const tooltip = formatResetTooltip(bucket.resetTime, untouched);
            const label = bucket.label || bucket.shortLabel || '';

            return `
              <div class="bucket-item ${tone}" data-bucket-id="${esc(bucket.id)}">
                <div class="ring-wrap">
                  <svg class="ring-svg" viewBox="0 0 72 72" aria-hidden="true">
                    <circle class="ring-track" cx="36" cy="36" r="${BUCKET_RADIUS}"></circle>
                    <circle class="ring-progress" cx="36" cy="36" r="${BUCKET_RADIUS}"
                      stroke-dasharray="${BUCKET_CIRC.toFixed(2)}"
                      stroke-dashoffset="${offset}"
                      transform="rotate(-90 36 36)"></circle>
                  </svg>
                  <div class="ring-center">
                    <span class="ring-pct">${esc(pctText)}</span>
                  </div>
                </div>
                <div class="bucket-meta">
                  <span class="bucket-label">${esc(label)}</span>
                  <span class="bucket-reset${untouched ? ' is-untouched' : ''}"
                    data-reset-time="${esc(bucket.resetTime || '')}"
                    data-untouched="${untouched ? 'true' : 'false'}"
                    data-compact="true"
                    title="${esc(tooltip)}">${esc(resetText)}</span>
                </div>
              </div>`;
          })
          .join('');

        return `
          <article class="pool-card" data-group-id="${esc(group.id)}">
            <div class="pool-card-head">
              <h3 class="pool-name">${esc(group.name)}</h3>
            </div>
            <div class="buckets-row" data-count="${group.buckets.length}">
              ${bucketsHtml}
            </div>
          </article>`;
      })
      .join('');
  }

  function renderFamilies(families) {
    if (!Array.isArray(families) || families.length === 0) {
      els.familiesSection.classList.add('hidden');
      els.familiesSummary.textContent = 'Модели по семействам (0)';
      els.familiesList.innerHTML = '';
      return;
    }

    els.familiesSection.classList.remove('hidden');
    els.familiesSummary.textContent = `Модели по семействам (${families.length})`;
    els.familiesList.innerHTML = families
      .map((fam) => {
        const frac = clampFraction(fam.remainingFraction);
        const pctText = formatPercent(fam.percent, frac);
        const pctNum = Number.isFinite(Number(fam.percent)) ? Number(fam.percent) : frac * 100;
        const tone = toneClass(pctNum);
        const offset = (MINI_CIRC * (1 - frac)).toFixed(2);
        const untouched = Boolean(fam.untouched);
        const resetText = formatCountdown(fam.resetTime, untouched, true);
        const tooltip = formatResetTooltip(fam.resetTime, untouched);

        const tagHtml = fam.tagTitle
          ? `<span class="badge badge-tag ${/leaving/i.test(fam.tagTitle) ? 'badge-warn' : 'badge-primary'}">${esc(fam.tagTitle)}</span>`
          : '';
        const tiersHtml = Array.isArray(fam.tiers) && fam.tiers.length
          ? fam.tiers.map((t) => `<span class="tier-pill">${esc(t)}</span>`).join('')
          : '';

        return `
          <div class="family-row ${tone}">
            <svg class="mini-ring" viewBox="0 0 28 28" aria-hidden="true">
              <circle class="mini-track" cx="14" cy="14" r="${MINI_RADIUS}"></circle>
              <circle class="mini-progress" cx="14" cy="14" r="${MINI_RADIUS}"
                stroke-dasharray="${MINI_CIRC.toFixed(2)}"
                stroke-dashoffset="${offset}"
                transform="rotate(-90 14 14)"></circle>
            </svg>
            <div class="family-main">
              <div class="family-top">
                <span class="family-name">${esc(fam.name)}</span>
                ${tagHtml}
              </div>
              ${tiersHtml ? `<div class="family-meta">${tiersHtml}</div>` : ''}
            </div>
            <div class="family-right">
              <span class="family-pct">${esc(pctText)}</span>
              <span class="family-reset${untouched ? ' is-untouched' : ''}"
                data-reset-time="${esc(fam.resetTime || '')}"
                data-untouched="${untouched ? 'true' : 'false'}"
                data-compact="true"
                title="${esc(tooltip)}">${esc(resetText)}</span>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderUnavailable(unavailable) {
    if (!Array.isArray(unavailable) || unavailable.length === 0) {
      els.unavailableSection.classList.add('hidden');
      els.unavailableList.innerHTML = '';
      return;
    }

    els.unavailableSection.classList.remove('hidden');
    els.unavailableSummary.textContent = `Недоступные модели (${unavailable.length})`;
    els.unavailableList.innerHTML = unavailable
      .map(
        (item) => `
          <li class="unavailable-item">
            <span>${esc(item.name)}</span>
            <span class="badge badge-tag">${esc(item.tagTitle || 'Unavailable')}</span>
          </li>`
      )
      .join('');
  }

  function renderPrefs(prefs, menuBar) {
    if (prefs) {
      state.prefs = {
        ...state.prefs,
        ...prefs,
        thresholds: Array.isArray(prefs.thresholds) ? prefs.thresholds : state.prefs.thresholds,
      };
    }
    if (menuBar !== undefined) {
      state.menuBar = menuBar;
    }

    els.prefNotifications.checked = Boolean(state.prefs.notificationsEnabled);
    els.prefReset.checked = Boolean(state.prefs.notifyOnReset);
    els.prefMenubar.checked = Boolean(state.prefs.menuBarEnabled);

    const activeThresholds = new Set(state.prefs.thresholds.map(Number));
    for (const btn of els.thresholdChips.querySelectorAll('[data-threshold]')) {
      const val = Number(btn.getAttribute('data-threshold'));
      const active = activeThresholds.has(val);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    const currentInterval = Number(state.prefs.pollIntervalSec) || 30;
    for (const btn of els.intervalChips.querySelectorAll('[data-interval]')) {
      const val = Number(btn.getAttribute('data-interval'));
      const active = val === currentInterval;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    if (state.menuBar) {
      if (!state.menuBar.available) {
        els.menubarStatus.textContent = state.menuBar.error || 'Menu Bar недоступен';
      } else if (state.menuBar.running) {
        els.menubarStatus.textContent = 'Menu Bar активен';
      } else if (state.menuBar.error) {
        els.menubarStatus.textContent = state.menuBar.error;
      } else {
        els.menubarStatus.textContent = 'Menu Bar выключен';
      }
    } else {
      els.menubarStatus.textContent = '';
    }
  }

  function renderAll(data) {
    state.data = data;
    els.loading.classList.add('hidden');
    els.app.classList.remove('hidden');

    if (data.ok === false) {
      els.errorBanner.classList.remove('hidden');
      els.errorMessage.textContent = data.error || 'Неизвестная ошибка сервера';
      setLiveState('error', 'Ошибка');
    } else {
      els.errorBanner.classList.add('hidden');
      els.errorMessage.textContent = '';
      setLiveState('live', 'Live');
    }

    els.updatedAt.textContent = formatUpdatedAt(data.updatedAt);
    renderPlan(data.plan);
    renderGroups(data);
    renderFamilies(data.families || []);
    renderUnavailable(data.unavailable || []);
    renderPrefs(data.prefs, data.menuBar);
    schedulePoll();
  }

  // ---------- data & actions ----------
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    const sec = Math.max(10, Math.min(300, Number(state.prefs.pollIntervalSec) || 30));
    state.pollTimer = setTimeout(() => {
      loadQuotas({ force: false });
    }, sec * 1000);
  }

  async function loadQuotas({ force = false } = {}) {
    if (state.inFlight) return;
    state.inFlight = true;
    els.refreshBtn.disabled = true;
    if (force) els.refreshBtn.classList.add('is-spinning');
    if (!state.loading) setLiveState('loading', 'Обновление…');

    try {
      const data = force ? await postJson('/api/refresh') : await getJson('/api/quotas');
      state.loading = false;
      renderAll(data);
      if (force && data?.ok !== false) {
        showToast('Лимиты обновлены');
      }
    } catch (err) {
      state.loading = false;
      els.loading.classList.add('hidden');
      els.app.classList.remove('hidden');
      els.errorBanner.classList.remove('hidden');
      els.errorMessage.textContent = err?.message || 'Ошибка соединения со sidecar';
      setLiveState('error', 'Ошибка');
      schedulePoll();
    } finally {
      state.inFlight = false;
      els.refreshBtn.disabled = false;
      els.refreshBtn.classList.remove('is-spinning');
    }
  }

  async function savePrefs(partial) {
    try {
      const res = await postJson('/api/prefs', partial);
      if (res?.ok === false) {
        throw new Error(res.error || 'Не удалось сохранить настройки');
      }
      renderPrefs(res.prefs, res.menuBar);
      schedulePoll();
      showToast('Настройки сохранены');
    } catch (err) {
      renderPrefs(state.prefs, state.menuBar);
      showToast(err?.message || 'Ошибка сохранения настроек', true);
    }
  }

  async function sendTestNotification() {
    els.notifyTestBtn.disabled = true;
    try {
      const res = await postJson('/api/notify-test');
      if (res?.ok === false) {
        throw new Error(res.error || 'Не удалось отправить уведомление');
      }
      showToast('Тестовое уведомление отправлено');
    } catch (err) {
      showToast(err?.message || 'Ошибка отправки уведомления', true);
    } finally {
      els.notifyTestBtn.disabled = false;
    }
  }

  // ---------- events ----------
  els.refreshBtn.addEventListener('click', () => loadQuotas({ force: true }));
  els.retryBtn.addEventListener('click', () => loadQuotas({ force: true }));

  els.prefNotifications.addEventListener('change', (e) => {
    savePrefs({ notificationsEnabled: Boolean(e.target.checked) });
  });

  els.prefReset.addEventListener('change', (e) => {
    savePrefs({ notifyOnReset: Boolean(e.target.checked) });
  });

  els.prefMenubar.addEventListener('change', (e) => {
    savePrefs({ menuBarEnabled: Boolean(e.target.checked) });
  });

  els.thresholdChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-threshold]');
    if (!btn) return;
    const val = Number(btn.getAttribute('data-threshold'));
    const next = new Set(state.prefs.thresholds.map(Number));
    if (next.has(val)) {
      next.delete(val);
    } else {
      next.add(val);
    }
    const sorted = Array.from(next).sort((a, b) => b - a);
    savePrefs({ thresholds: sorted });
  });

  els.intervalChips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-interval]');
    if (!btn) return;
    const sec = Number(btn.getAttribute('data-interval'));
    if (!Number.isFinite(sec)) return;
    savePrefs({ pollIntervalSec: sec });
  });

  els.notifyTestBtn.addEventListener('click', sendTestNotification);

  // ---------- start ----------
  setInterval(updateCountdowns, 1000);
  loadQuotas({ force: false });
})();
