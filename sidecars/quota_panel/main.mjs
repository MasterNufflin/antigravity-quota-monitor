import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(__dirname, '.data');
mkdirSync(dataDir, { recursive: true });

const prefsPath = join(dataDir, 'prefs.json');
const snapshotPath = join(dataDir, 'snapshot.json');
const localMenubarBin = join(__dirname, 'menubar');
const dataMenubarBin = join(dataDir, 'menubar');
const menubarSwift = join(__dirname, 'menubar.swift');
const swiftcPath = '/usr/bin/swiftc';

const TIER_ORDER = ['Low', 'Medium', 'High', 'XHigh'];
const TIER_SUFFIX_RE = /\s*\((Low|Medium|High|XHigh)\)\s*$/;
const PROVIDER_ORDER = { Gemini: 0, 'Claude / GPT-OSS': 1, Other: 2 };
const GROUP_ORDER = { Gemini: 0, 'Claude / GPT': 1 };
const WINDOW_ORDER = { '5h': 0, weekly: 1 };

const DEFAULT_PREFS = {
  notificationsEnabled: true,
  thresholds: [50, 25, 10, 0],
  notifyOnReset: true,
  menuBarEnabled: true,
  pollIntervalSec: 30,
};

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

function clampPollInterval(val, fallback = DEFAULT_PREFS.pollIntervalSec) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(300, Math.max(10, Math.round(n)));
}

function normalizeThresholds(val, fallback = DEFAULT_PREFS.thresholds) {
  if (!Array.isArray(val)) return [...fallback];
  const seen = new Set();
  for (const item of val) {
    const n = Number(item);
    if (!Number.isFinite(n)) continue;
    const clamped = Math.min(99, Math.max(0, Math.round(n)));
    seen.add(clamped);
  }
  return [...seen].sort((a, b) => b - a);
}

function normalizePrefs(raw, base = DEFAULT_PREFS) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    notificationsEnabled:
      typeof src.notificationsEnabled === 'boolean'
        ? src.notificationsEnabled
        : base.notificationsEnabled,
    thresholds:
      src.thresholds !== undefined
        ? normalizeThresholds(src.thresholds, base.thresholds)
        : [...base.thresholds],
    notifyOnReset:
      typeof src.notifyOnReset === 'boolean'
        ? src.notifyOnReset
        : base.notifyOnReset,
    menuBarEnabled:
      typeof src.menuBarEnabled === 'boolean'
        ? src.menuBarEnabled
        : base.menuBarEnabled,
    pollIntervalSec:
      src.pollIntervalSec !== undefined
        ? clampPollInterval(src.pollIntervalSec, base.pollIntervalSec)
        : base.pollIntervalSec,
  };
}

function loadPrefs() {
  try {
    if (!existsSync(prefsPath)) return normalizePrefs(DEFAULT_PREFS);
    const parsed = JSON.parse(readFileSync(prefsPath, 'utf-8'));
    return normalizePrefs(parsed, DEFAULT_PREFS);
  } catch {
    return normalizePrefs(DEFAULT_PREFS);
  }
}

function classifyProvider(label) {
  if (/gemini|orchestrator/i.test(label)) {
    return { name: 'Gemini', key: 'gemini' };
  }
  if (/claude|gpt/i.test(label)) {
    return { name: 'Claude / GPT-OSS', key: 'claude' };
  }
  return { name: 'Other', key: 'other' };
}

function shortFamilyName(name, provider) {
  let short = name;
  if (provider === 'Gemini') {
    short = short.replace(/^Gemini\s+(?:\d+(?:\.\d+)?\s+)?/i, '');
  } else if (provider === 'Claude / GPT-OSS') {
    short = short.replace(/^Claude\s+/i, '');
  }
  short = short.trim();
  return short || name;
}

export function parseUserStatus(raw) {
  const us = raw?.userStatus || raw || {};
  const plan = {
    tier: us.userTier?.name || us.planStatus?.planInfo?.planName || null,
    promptCredits:
      typeof us.planStatus?.availablePromptCredits === 'number'
        ? us.planStatus.availablePromptCredits
        : null,
    flowCredits:
      typeof us.planStatus?.availableFlowCredits === 'number'
        ? us.planStatus.availableFlowCredits
        : null,
  };

  const configs = Array.isArray(us.cascadeModelConfigData?.clientModelConfigs)
    ? us.cascadeModelConfigData.clientModelConfigs
    : [];

  const poolMap = new Map();
  const familyMap = new Map();
  const unavailable = [];

  for (const m of configs) {
    if (!m || typeof m !== 'object') continue;
    const label = typeof m.label === 'string' ? m.label.trim() : '';
    if (!label) continue;

    const tagTitle =
      typeof m.tagTitle === 'string' && m.tagTitle.trim()
        ? m.tagTitle.trim()
        : null;
    const qi = m.quotaInfo;
    const hasFraction =
      typeof qi?.remainingFraction === 'number' &&
      Number.isFinite(qi.remainingFraction);
    const resetTime =
      typeof qi?.resetTime === 'string' && qi.resetTime.trim()
        ? qi.resetTime.trim()
        : null;

    if (tagTitle === 'Unavailable' || !qi || (!hasFraction && !resetTime)) {
      unavailable.push({
        name: label,
        tagTitle: tagTitle || 'Unavailable',
      });
      continue;
    }

    // Proto3 zero-float edge case: remainingFraction omitted when 0, while resetTime is present.
    let remainingFraction = hasFraction ? qi.remainingFraction : 0;
    remainingFraction = Math.min(1, Math.max(0, remainingFraction));
    const percent = Math.round(remainingFraction * 1000) / 10;
    const untouched = remainingFraction >= 0.9999;

    const provider = classifyProvider(label);
    const poolId = `${provider.key}|${Math.round(remainingFraction * 1000)}|${resetTime || ''}`;

    let pool = poolMap.get(poolId);
    if (!pool) {
      pool = {
        id: poolId,
        name: provider.name,
        subtitle: '',
        remainingFraction,
        percent,
        resetTime,
        untouched,
        modelCount: 0,
        _shortNames: new Set(),
      };
      poolMap.set(poolId, pool);
    }
    pool.modelCount += 1;

    const tierMatch = TIER_SUFFIX_RE.exec(label);
    const tier = tierMatch ? tierMatch[1] : null;
    const baseName = tierMatch ? label.slice(0, tierMatch.index).trim() : label;

    pool._shortNames.add(shortFamilyName(baseName, provider.name));

    const familyKey = `${poolId}::${baseName}`;
    let family = familyMap.get(familyKey);
    if (!family) {
      family = {
        name: baseName,
        poolId,
        provider: provider.name,
        tiers: [],
        remainingFraction,
        percent,
        resetTime,
        untouched,
        tagTitle,
        available: true,
      };
      familyMap.set(familyKey, family);
    } else if (!family.tagTitle && tagTitle) {
      family.tagTitle = tagTitle;
    }

    if (tier && !family.tiers.includes(tier)) {
      family.tiers.push(tier);
      family.tiers.sort(
        (a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b),
      );
    }
  }

  const pools = [...poolMap.values()]
    .map(({ _shortNames, ...rest }) => ({
      ...rest,
      subtitle: [..._shortNames].slice(0, 6).join(' · '),
    }))
    .sort((a, b) => {
      const pa = PROVIDER_ORDER[a.name] ?? 99;
      const pb = PROVIDER_ORDER[b.name] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.remainingFraction - b.remainingFraction;
    });

  const poolIndex = new Map(pools.map((p, idx) => [p.id, idx]));
  const families = [...familyMap.values()].sort((a, b) => {
    const ia = poolIndex.get(a.poolId) ?? 999;
    const ib = poolIndex.get(b.poolId) ?? 999;
    return ia - ib;
  });

  return { plan, pools, families, unavailable };
}

function normalizeGroupMeta(rawName, rawId) {
  const hint = `${rawName || ''} ${rawId || ''}`.trim();
  if (/gemini/i.test(hint)) {
    return { id: 'gemini', name: 'Gemini' };
  }
  if (/claude|gpt|3p|third/i.test(hint)) {
    return { id: 'claude-gpt', name: 'Claude / GPT' };
  }
  const cleanName =
    String(rawName || rawId || 'Other')
      .replace(/\s+models\s*$/i, '')
      .trim() || 'Other';
  const slug =
    String(rawId || cleanName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'other';
  return { id: slug, name: cleanName };
}

function bucketWindowInfo(b) {
  const hint = String(b?.bucketId || b?.displayName || b?.id || '');
  let win;
  if (b?.window === '5h' || /5h|five/i.test(hint)) {
    win = '5h';
  } else if (b?.window === 'weekly' || /week/i.test(hint)) {
    win = 'weekly';
  } else {
    win = String(b?.window || 'other');
  }

  if (win === '5h') {
    return { window: '5h', label: '5 часов', shortLabel: '5ч' };
  }
  if (win === 'weekly') {
    return { window: 'weekly', label: 'Неделя', shortLabel: '7д' };
  }
  const fallbackLabel = String(b?.displayName || b?.label || win);
  return {
    window: win,
    label: fallbackLabel,
    shortLabel: String(b?.shortLabel || fallbackLabel),
  };
}

export function parseQuotaSummary(raw) {
  const rawGroups = raw?.response?.groups || raw?.groups;
  if (!Array.isArray(rawGroups)) return [];

  const groupMap = new Map();

  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const rawName = g.displayName || g.groupName || g.name || g.groupId || g.id;
    const rawId = g.groupId || g.id;
    const meta = normalizeGroupMeta(rawName, rawId);

    let group = groupMap.get(meta.id);
    if (!group) {
      group = {
        id: meta.id,
        name: meta.name,
        buckets: [],
      };
      groupMap.set(meta.id, group);
    }

    const rawBuckets = Array.isArray(g.buckets) ? g.buckets : [];
    for (const b of rawBuckets) {
      if (!b || typeof b !== 'object') continue;
      const hasFraction =
        typeof b.remainingFraction === 'number' &&
        Number.isFinite(b.remainingFraction);
      const resetTime =
        typeof b.resetTime === 'string' && b.resetTime.trim()
          ? b.resetTime.trim()
          : null;

      if (!hasFraction && !resetTime) continue;

      let remainingFraction = hasFraction ? b.remainingFraction : 0;
      remainingFraction = Math.min(1, Math.max(0, remainingFraction));
      const percent = Math.round(remainingFraction * 1000) / 10;
      const untouched = remainingFraction >= 0.9999;

      const winInfo = bucketWindowInfo(b);
      const bucketId =
        typeof b.bucketId === 'string' && b.bucketId.trim()
          ? b.bucketId.trim()
          : typeof b.id === 'string' && b.id.trim()
            ? b.id.trim()
            : `${meta.id}-${winInfo.window}`;

      const existingIdx = group.buckets.findIndex((x) => x.id === bucketId);
      const bucketObj = {
        id: bucketId,
        window: winInfo.window,
        label: winInfo.label,
        shortLabel: winInfo.shortLabel,
        remainingFraction,
        percent,
        resetTime,
        untouched,
      };
      if (existingIdx >= 0) {
        group.buckets[existingIdx] = bucketObj;
      } else {
        group.buckets.push(bucketObj);
      }
    }
  }

  const groups = [...groupMap.values()].filter((g) => g.buckets.length > 0);
  for (const g of groups) {
    g.buckets.sort((a, b) => {
      const wa = WINDOW_ORDER[a.window] ?? 99;
      const wb = WINDOW_ORDER[b.window] ?? 99;
      return wa - wb;
    });
  }

  groups.sort((a, b) => {
    const ga = GROUP_ORDER[a.name] ?? 99;
    const gb = GROUP_ORDER[b.name] ?? 99;
    return ga - gb;
  });

  return groups;
}

function synthesizeGroupsFromPools(pools) {
  if (!Array.isArray(pools) || pools.length === 0) return [];
  const nowMs = Date.now();
  const DAY_MS = 24 * 3600 * 1000;
  const groupMap = new Map();

  for (const pool of pools) {
    const meta = normalizeGroupMeta(pool.name, pool.id);
    let group = groupMap.get(meta.id);
    if (!group) {
      group = { id: meta.id, name: meta.name, buckets: [] };
      groupMap.set(meta.id, group);
    }

    const resetMs = pool.resetTime ? Date.parse(pool.resetTime) : NaN;
    const isWeekly = Number.isFinite(resetMs) && resetMs - nowMs > DAY_MS;
    const win = isWeekly ? 'weekly' : '5h';
    const label = isWeekly ? 'Неделя' : '5 часов';
    const shortLabel = isWeekly ? '7д' : '5ч';
    const bucketId = `${meta.id}-${win}`;

    const existing = group.buckets.find((b) => b.window === win);
    if (!existing || pool.remainingFraction < existing.remainingFraction) {
      const nextBucket = {
        id: bucketId,
        window: win,
        label,
        shortLabel,
        remainingFraction: pool.remainingFraction,
        percent: pool.percent,
        resetTime: pool.resetTime || null,
        untouched: Boolean(pool.untouched),
      };
      if (existing) {
        Object.assign(existing, nextBucket);
      } else {
        group.buckets.push(nextBucket);
      }
    }
  }

  const groups = [...groupMap.values()];
  for (const g of groups) {
    g.buckets.sort((a, b) => {
      const wa = WINDOW_ORDER[a.window] ?? 99;
      const wb = WINDOW_ORDER[b.window] ?? 99;
      return wa - wb;
    });
  }
  groups.sort((a, b) => {
    const ga = GROUP_ORDER[a.name] ?? 99;
    const gb = GROUP_ORDER[b.name] ?? 99;
    return ga - gb;
  });
  return groups;
}

function escapeAppleScriptString(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sendMacNotification(body, title = 'Antigravity Quotas') {
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      ok: false,
      error: 'Системные уведомления сейчас поддерживаются только на macOS',
    });
  }
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
  return new Promise((res) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5000 }, (err) => {
      if (err) {
        res({ ok: false, error: err.message });
      } else {
        res({ ok: true });
      }
    });
  });
}

function parseRequestBody(data) {
  if (!data) return {};
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  if (typeof data.body === 'string') {
    try {
      return JSON.parse(data.body);
    } catch {
      return data;
    }
  }
  if (data.body && typeof data.body === 'object') return data.body;
  return data;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let prefs = loadPrefs();
let lastGood = {
  plan: { tier: null, promptCredits: null, flowCredits: null },
  groups: [],
  pools: [],
  families: [],
  unavailable: [],
};
let latestStatus = {
  ok: false,
  error: null,
  updatedAt: null,
  ...lastGood,
};

let hasPolledSuccess = false;
const prevQuotaPct = new Map();
let pollTimer = null;
let inFlightPoll = null;

// Menu Bar subprocess state
let menuBarChild = null;
let menuBarRestartTimer = null;
let stoppingMenuBar = false;
let shuttingDown = false;
let menuBarCompiling = false;
let menuBarCompileFailed = false;
const menuBarCrashTimes = [];
const menuBarState = {
  available: process.platform === 'darwin',
  running: false,
  error: process.platform === 'darwin' ? null : 'Menu Bar доступен только на macOS',
};

function mtimeMsOf(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveMenuBarBin() {
  if (process.platform !== 'darwin') return null;
  const swiftMtime = mtimeMsOf(menubarSwift);
  const dataMtime = mtimeMsOf(dataMenubarBin);
  const localMtime = mtimeMsOf(localMenubarBin);

  const dataFresh = dataMtime > 0 && (swiftMtime === 0 || dataMtime >= swiftMtime);
  const localFresh = localMtime > 0 && (swiftMtime === 0 || localMtime >= swiftMtime);

  if (dataFresh && localFresh) {
    return dataMtime >= localMtime ? dataMenubarBin : localMenubarBin;
  }
  if (dataFresh) return dataMenubarBin;
  if (localFresh) return localMenubarBin;
  return null;
}

function ensureMenuBarCompiled() {
  if (process.platform !== 'darwin' || shuttingDown) return;
  if (menuBarCompiling || menuBarCompileFailed) return;
  if (!existsSync(menubarSwift)) {
    menuBarState.available = false;
    menuBarState.error = 'menubar.swift не найден';
    return;
  }
  if (!existsSync(swiftcPath)) {
    menuBarState.available = false;
    menuBarState.error = 'Установите Xcode CLT (xcode-select --install) для Menu Bar';
    return;
  }

  menuBarCompiling = true;
  menuBarState.available = true;
  menuBarState.running = false;
  menuBarState.error = 'Сборка Menu Bar…';

  const tmpBin = `${dataMenubarBin}.new`;
  const cacheDir = join(dataDir, 'swift-cache');
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    // ignore
  }

  execFile(
    swiftcPath,
    ['-O', '-module-cache-path', cacheDir, '-framework', 'Cocoa', menubarSwift, '-o', tmpBin],
    { timeout: 60_000 },
    (err) => {
      menuBarCompiling = false;
      if (err) {
        menuBarCompileFailed = true;
        menuBarState.available = false;
        menuBarState.error = `Ошибка сборки Menu Bar: ${err.message}`;
        console.error('[quota_panel] failed to compile menubar.swift:', err);
        return;
      }
      try {
        renameSync(tmpBin, dataMenubarBin);
      } catch (renameErr) {
        menuBarCompileFailed = true;
        menuBarState.available = false;
        menuBarState.error = `Ошибка сохранения Menu Bar: ${renameErr.message}`;
        return;
      }
      menuBarState.available = true;
      menuBarState.error = null;
      if (prefs.menuBarEnabled && !shuttingDown) {
        startMenuBar();
      }
    },
  );
}

function stopMenuBar() {
  if (menuBarRestartTimer) {
    clearTimeout(menuBarRestartTimer);
    menuBarRestartTimer = null;
  }
  if (menuBarChild) {
    stoppingMenuBar = true;
    try {
      menuBarChild.kill('SIGTERM');
    } catch {
      // ignore
    }
    menuBarChild = null;
  }
  menuBarState.running = false;
}

function startMenuBar() {
  if (process.platform !== 'darwin') {
    menuBarState.available = false;
    menuBarState.running = false;
    menuBarState.error = 'Menu Bar доступен только на macOS';
    return;
  }
  if (!prefs.menuBarEnabled || shuttingDown) return;
  if (menuBarChild) return;

  const binPath = resolveMenuBarBin();
  if (!binPath) {
    ensureMenuBarCompiled();
    return;
  }
  menuBarState.available = true;

  if (menuBarRestartTimer) {
    clearTimeout(menuBarRestartTimer);
    menuBarRestartTimer = null;
  }

  stoppingMenuBar = false;
  try {
    const child = spawn(
      binPath,
      ['--snapshot', snapshotPath, '--parent-pid', String(process.pid)],
      { stdio: 'ignore' },
    );
    menuBarChild = child;
    menuBarState.running = true;
    menuBarState.error = null;

    child.on('error', (err) => {
      if (menuBarChild === child) menuBarChild = null;
      menuBarState.running = false;
      menuBarState.error = err.message;
    });

    child.on('exit', (code) => {
      if (menuBarChild === child) menuBarChild = null;
      menuBarState.running = false;

      if (stoppingMenuBar || shuttingDown) {
        stoppingMenuBar = false;
        return;
      }

      if (code === 42) {
        prefs.menuBarEnabled = false;
        try {
          writeJsonAtomic(prefsPath, prefs);
        } catch (err) {
          console.error('[quota_panel] failed to save prefs after exit 42:', err);
        }
        return;
      }

      if (!prefs.menuBarEnabled) return;

      const now = Date.now();
      while (menuBarCrashTimes.length && now - menuBarCrashTimes[0] > 60_000) {
        menuBarCrashTimes.shift();
      }
      menuBarCrashTimes.push(now);

      if (menuBarCrashTimes.length <= 3) {
        menuBarState.error = `menubar exited (${code ?? 'signal'}), restarting`;
        menuBarRestartTimer = setTimeout(() => {
          menuBarRestartTimer = null;
          startMenuBar();
        }, 5000);
      } else {
        menuBarState.error = 'menubar crashed repeatedly; auto-restart paused';
      }
    });
  } catch (err) {
    menuBarChild = null;
    menuBarState.running = false;
    menuBarState.error = err.message;
  }
}

function syncMenuBar() {
  if (process.platform !== 'darwin') {
    menuBarState.available = false;
    menuBarState.running = false;
    menuBarState.error = 'Menu Bar доступен только на macOS';
    return;
  }
  const hasBin = Boolean(resolveMenuBarBin());
  menuBarState.available = hasBin || (existsSync(menubarSwift) && existsSync(swiftcPath));
  if (prefs.menuBarEnabled && !shuttingDown) {
    startMenuBar();
  } else {
    stopMenuBar();
    if (!prefs.menuBarEnabled && !menuBarCompiling) menuBarState.error = null;
  }
}

function processQuotaNotifications(groups, pools) {
  const entries = [];
  if (Array.isArray(groups) && groups.length > 0) {
    for (const g of groups) {
      for (const b of g.buckets || []) {
        entries.push({
          key: `${g.id}:${b.window}`,
          label: `${g.name} (${b.shortLabel || b.window})`,
          percent: b.percent,
        });
      }
    }
  } else if (Array.isArray(pools)) {
    const byName = new Map();
    for (const p of pools) {
      const existing = byName.get(p.name);
      if (existing === undefined || p.percent < existing) {
        byName.set(p.name, p.percent);
      }
    }
    for (const [name, pct] of byName.entries()) {
      entries.push({
        key: `pool:${name}`,
        label: name,
        percent: pct,
      });
    }
  }

  if (entries.length === 0) return;

  if (!hasPolledSuccess) {
    hasPolledSuccess = true;
    for (const entry of entries) {
      prevQuotaPct.set(entry.key, entry.percent);
    }
    return;
  }

  for (const entry of entries) {
    const prev = prevQuotaPct.get(entry.key);
    const curr = entry.percent;
    if (typeof prev === 'number') {
      if (prefs.notificationsEnabled) {
        const crossed = prefs.thresholds.filter((t) => prev > t && curr <= t);
        if (crossed.length > 0) {
          const minThreshold = Math.min(...crossed);
          void sendMacNotification(
            `Квота ${entry.label}: осталось ${Math.round(curr)}% (порог ${minThreshold}%)`,
          );
        }
      }
      if (prefs.notifyOnReset && prev < 80 && curr >= 99) {
        void sendMacNotification(`Квота ${entry.label} восстановлена до 100%`);
      }
    }
    prevQuotaPct.set(entry.key, curr);
  }
}

async function callLsMethod(addr, method) {
  const url = `http://${addr}/exa.language_server_pb.LanguageServerService/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': process.env.ANTIGRAVITY_CSRF_TOKEN || '',
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify({
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en',
      },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`${method} HTTP ${res.status}`);
  }
  return res.json();
}

async function pollQuotas() {
  if (inFlightPoll) return inFlightPoll;

  inFlightPoll = (async () => {
    const addr = process.env.ANTIGRAVITY_LS_ADDRESS || 'localhost:5387';
    const nowIso = new Date().toISOString();

    const [summaryRes, statusRes] = await Promise.allSettled([
      callLsMethod(addr, 'RetrieveUserQuotaSummary'),
      callLsMethod(addr, 'GetUserStatus'),
    ]);

    const summaryOk = summaryRes.status === 'fulfilled';
    const statusOk = statusRes.status === 'fulfilled';

    let nextUserStatus = {
      plan: lastGood.plan,
      pools: lastGood.pools,
      families: lastGood.families,
      unavailable: lastGood.unavailable,
    };
    if (statusOk) {
      nextUserStatus = parseUserStatus(statusRes.value);
    }

    let nextGroups = [];
    if (summaryOk) {
      nextGroups = parseQuotaSummary(summaryRes.value);
    }
    if (nextGroups.length === 0) {
      if (statusOk) {
        nextGroups = synthesizeGroupsFromPools(nextUserStatus.pools);
      } else if (lastGood.groups.length > 0) {
        nextGroups = lastGood.groups;
      } else {
        nextGroups = synthesizeGroupsFromPools(nextUserStatus.pools);
      }
    }

    if (summaryOk || statusOk) {
      lastGood = {
        ...nextUserStatus,
        groups: nextGroups,
      };
      latestStatus = {
        ok: true,
        error: null,
        updatedAt: nowIso,
        ...lastGood,
      };
      processQuotaNotifications(lastGood.groups, lastGood.pools);
    } else {
      const errs = [
        summaryRes.reason?.message || 'RetrieveUserQuotaSummary failed',
        statusRes.reason?.message || 'GetUserStatus failed',
      ];
      latestStatus = {
        ok: false,
        error: errs.join('; '),
        updatedAt: latestStatus.updatedAt || nowIso,
        ...lastGood,
      };
    }

    syncMenuBar();

    try {
      writeJsonAtomic(snapshotPath, latestStatus);
    } catch (err) {
      console.error('[quota_panel] failed to write snapshot.json:', err);
    }

    return buildResponsePayload();
  })();

  try {
    return await inFlightPoll;
  } finally {
    inFlightPoll = null;
  }
}

function buildResponsePayload() {
  return {
    ...latestStatus,
    prefs: { ...prefs, thresholds: [...prefs.thresholds] },
    menuBar: { ...menuBarState },
  };
}

function restartPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollTimer = setInterval(() => {
    void pollQuotas();
  }, prefs.pollIntervalSec * 1000);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function cleanup() {
  shuttingDown = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  stopMenuBar();
}

function isMainEntry() {
  try {
    if (!process.argv[1]) return true;
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(process.argv[1]))
    );
  } catch {
    return true;
  }
}

if (isMainEntry()) {
  const app = new SidecarApp();

  app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

  app.api(
    '/styles.css',
    () =>
      new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), {
        contentType: 'text/css; charset=utf-8',
      }),
    'GET',
  );

  app.api(
    '/app.js',
    () =>
      new Response(readFileSync(join(__dirname, 'app.js'), 'utf-8'), {
        contentType: 'application/javascript; charset=utf-8',
      }),
    'GET',
  );

  app.api(
    '/api/quotas',
    async () => {
      if (!latestStatus.updatedAt) {
        return await pollQuotas();
      }
      return buildResponsePayload();
    },
    'GET',
  );

  app.api(
    '/api/refresh',
    async () => {
      return await pollQuotas();
    },
    'POST',
  );

  app.api(
    '/api/prefs',
    (data) => {
      const patch = parseRequestBody(data);
      prefs = normalizePrefs(patch, prefs);
      try {
        writeJsonAtomic(prefsPath, prefs);
      } catch (err) {
        return {
          ok: false,
          error: err?.message || 'Failed to persist prefs',
          prefs: { ...prefs, thresholds: [...prefs.thresholds] },
          menuBar: { ...menuBarState },
        };
      }
      syncMenuBar();
      restartPollTimer();
      return {
        ok: true,
        prefs: { ...prefs, thresholds: [...prefs.thresholds] },
        menuBar: { ...menuBarState },
      };
    },
    'POST',
  );

  app.api(
    '/api/notify-test',
    async () => {
      return await sendMacNotification(
        'Уведомления о лимитах Antigravity работают!',
        'Antigravity Quotas',
      );
    },
    'POST',
  );

  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('beforeExit', cleanup);
  process.on('exit', cleanup);

  try {
    writeJsonAtomic(prefsPath, prefs);
  } catch (err) {
    console.error('[quota_panel] failed to initialize prefs.json:', err);
  }

  syncMenuBar();
  void pollQuotas();
  restartPollTimer();
  app.run();
}
