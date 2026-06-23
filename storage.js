const STORAGE_KEY = 'focusAnalyticsState';

export const DEFAULT_SETTINGS = {
  productiveDomains: [
    'chatgpt.com',
    'github.com',
    'stackoverflow.com',
    'developer.mozilla.org'
  ],
  distractingDomains: [
    'instagram.com',
    'youtube.com',
    'facebook.com',
    'x.com'
  ],
  focusSessionMinMinutes: 25,
  interruptionGraceSeconds: 30,
  export: {
    includeSegments: true,
    includeFocusSessions: true,
    includeInsights: true,
    includeSettings: true
  },
  scoreWeights: {
    productiveRatio: 0.55,
    focusBonus: 0.2,
    switchPenalty: 0.15,
    distractionPenalty: 0.1,
    switchSaturationPerHour: 20,
    focusTargetMinutes: 50
  }
};

function mergeDeep(target, source) {
  if (Array.isArray(source)) {
    return source.slice();
  }

  if (!source || typeof source !== 'object') {
    return source;
  }

  const output = { ...(target || {}) };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeDeep(output[key], value);
    } else if (Array.isArray(value)) {
      output[key] = value.slice();
    } else {
      output[key] = value;
    }
  }
  return output;
}

function createEmptyDailyStats() {
  return {
    tabSwitches: 0,
    activeSeconds: 0,
    idleSeconds: 0,
    focusSessions: 0,
    pageNavigations: 0,
    tabOpens: 0,
    tabCloses: 0,
    windowFocusChanges: 0,
    productiveSeconds: 0,
    distractingSeconds: 0
  };
}

function createEmptyFocusSummary() {
  return {
    count: 0,
    totalDuration: 0,
    averageDuration: 0,
    longestDuration: 0,
    sessions: []
  };
}

export function createDefaultState() {
  return {
    schemaVersion: 1,
    settings: mergeDeep(DEFAULT_SETTINGS, {}),
    currentSession: null,
    dailyUsage: {},
    dailyStats: {},
    segments: {},
    focusSessions: {},
    metadata: {
      createdAt: Date.now(),
      lastUpdatedAt: Date.now(),
      lastReconciledAt: null,
      lastAlarmAt: null
    }
  };
}

export function normalizeState(rawState) {
  const state = mergeDeep(createDefaultState(), rawState || {});
  state.settings = mergeDeep(DEFAULT_SETTINGS, state.settings || {});
  state.metadata = {
    ...createDefaultState().metadata,
    ...(state.metadata || {})
  };
  state.currentSession = state.currentSession ? { ...state.currentSession } : null;
  state.dailyUsage = state.dailyUsage || {};
  state.dailyStats = state.dailyStats || {};
  state.segments = state.segments || {};
  state.focusSessions = state.focusSessions || {};
  return state;
}

export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localDayKeyFromTimestamp(timestamp) {
  return localDayKey(new Date(timestamp));
}

export function toReadableMinutes(seconds) {
  return Number((seconds / 60).toFixed(1));
}

export function splitIntervalByDay(startMs, endMs) {
  const chunks = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const cursorDate = new Date(cursor);
    const nextMidnight = new Date(cursorDate);
    nextMidnight.setHours(24, 0, 0, 0);
    const chunkEnd = Math.min(endMs, nextMidnight.getTime());
    const seconds = Math.max(0, Math.round((chunkEnd - cursor) / 1000));

    if (seconds > 0) {
      chunks.push({
        dayKey: localDayKey(cursorDate),
        start: cursor,
        end: chunkEnd,
        seconds
      });
    }

    cursor = chunkEnd;
  }

  return chunks;
}

export function ensureDailyUsageBucket(state, dayKey) {
  if (!state.dailyUsage[dayKey]) {
    state.dailyUsage[dayKey] = {};
  }
  return state.dailyUsage[dayKey];
}

export function ensureDailyStatsBucket(state, dayKey) {
  if (!state.dailyStats[dayKey]) {
    state.dailyStats[dayKey] = createEmptyDailyStats();
  }
  return state.dailyStats[dayKey];
}

export function ensureSegmentsBucket(state, dayKey) {
  if (!state.segments[dayKey]) {
    state.segments[dayKey] = [];
  }
  return state.segments[dayKey];
}

export function ensureFocusSummaryBucket(state, dayKey) {
  if (!state.focusSessions[dayKey]) {
    state.focusSessions[dayKey] = createEmptyFocusSummary();
  }
  return state.focusSessions[dayKey];
}

export function addUsageSeconds(state, startMs, endMs, domain) {
  for (const chunk of splitIntervalByDay(startMs, endMs)) {
    const bucket = ensureDailyUsageBucket(state, chunk.dayKey);
    bucket[domain] = (bucket[domain] || 0) + chunk.seconds;
  }
}

export function addStatSeconds(state, startMs, endMs, statField) {
  for (const chunk of splitIntervalByDay(startMs, endMs)) {
    const bucket = ensureDailyStatsBucket(state, chunk.dayKey);
    bucket[statField] = (bucket[statField] || 0) + chunk.seconds;
  }
}

export function incrementDailyStat(state, dayKey, statField, amount = 1) {
  const bucket = ensureDailyStatsBucket(state, dayKey);
  bucket[statField] = (bucket[statField] || 0) + amount;
}

export function appendSegment(state, segment) {
  const dayKey = localDayKeyFromTimestamp(segment.start);
  const bucket = ensureSegmentsBucket(state, dayKey);
  bucket.push(segment);
}

export function replaceFocusSummary(state, dayKey, summary) {
  state.focusSessions[dayKey] = summary;
}

export async function loadState() {
  // MV3 service workers can disappear between events, so every handler rehydrates from storage.
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  if (hasChromeStorage) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeState(result[STORAGE_KEY]);
  } else {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return normalizeState(raw ? JSON.parse(raw) : null);
    } catch (e) {
      console.warn('localStorage is unavailable, returning default state:', e);
      return normalizeState(null);
    }
  }
}

export async function saveState(state) {
  const next = normalizeState(state);
  next.metadata.lastUpdatedAt = Date.now();
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  if (hasChromeStorage) {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('localStorage save failed:', e);
    }
  }
  return next;
}

export async function mutateState(updater) {
  const current = await loadState();
  const updated = await updater(current);
  return saveState(updated);
}

export async function ensureInitialized() {
  const state = await loadState();
  if (!state.settings || !state.schemaVersion) {
    await saveState(createDefaultState());
    return createDefaultState();
  }
  return state;
}
