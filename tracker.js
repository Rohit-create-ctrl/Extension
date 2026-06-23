import {
  appendSegment,
  ensureDailyStatsBucket,
  incrementDailyStat,
  localDayKeyFromTimestamp,
  loadState,
  mutateState,
  saveState,
  addStatSeconds,
  addUsageSeconds
} from './storage.js';
import {
  computeFocusSummaryFromSegments,
  classifyDomain,
  extractDomainFromUrl,
  isTrackableUrl,
  normalizeDomain
} from './analytics.js';

const HEARTBEAT_ALARM = 'focus-analytics-heartbeat';
const IDLE_DETECTION_SECONDS = 60;

function now() {
  return Date.now();
}

function callTabsGet(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(tab);
    });
  });
}

function callTabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(tabs);
    });
  });
}

function callWindowsGetLastFocused(queryInfo = {}) {
  return new Promise((resolve, reject) => {
    chrome.windows.getLastFocused(queryInfo, (window) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(window);
    });
  });
}

function callIdleQueryState(seconds) {
  return new Promise((resolve, reject) => {
    chrome.idle.queryState(seconds, (state) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(state);
    });
  });
}

function callSetIdleDetectionInterval(seconds) {
  return new Promise((resolve, reject) => {
    chrome.idle.setDetectionInterval(seconds, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function callAlarmsCreate(name, alarmInfo) {
  chrome.alarms.create(name, alarmInfo);
}

function isFocusedWindowId(windowId) {
  return Number.isInteger(windowId) && windowId !== chrome.windows.WINDOW_ID_NONE;
}

async function getTrackableContextForTab(tabId) {
  const tab = await callTabsGet(tabId);
  if (!tab || !isTrackableUrl(tab.url)) {
    return null;
  }

  const domain = extractDomainFromUrl(tab.url);
  if (!domain) {
    return null;
  }

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    domain: normalizeDomain(domain),
    title: tab.title || ''
  };
}

async function getFocusedContext() {
  const window = await callWindowsGetLastFocused({ populate: true });
  if (!window || !isFocusedWindowId(window.id) || !window.focused) {
    return null;
  }

  const activeTab = (window.tabs || []).find((tab) => tab.active) || null;
  if (!activeTab || !isTrackableUrl(activeTab.url)) {
    return null;
  }

  const domain = extractDomainFromUrl(activeTab.url);
  if (!domain) {
    return null;
  }

  return {
    tabId: activeTab.id,
    windowId: window.id,
    url: activeTab.url,
    domain: normalizeDomain(domain),
    title: activeTab.title || ''
  };
}

function appendSegmentAndSummaries(state, segment) {
  appendSegment(state, segment);
  const dayKey = localDayKeyFromTimestamp(segment.start);
  const focusSummary = computeFocusSummaryFromSegments(state.segments[dayKey] || [], state.settings || {});
  state.focusSessions[dayKey] = focusSummary;
  ensureDailyStatsBucket(state, dayKey).focusSessions = focusSummary.count;
}

function finalizeActiveSession(state, endTime, reason) {
  const session = state.currentSession;
  if (!session || session.isIdle) {
    return false;
  }

  const end = Math.max(endTime, session.lastActiveAt || session.startedAt || endTime);
  const start = session.startedAt || end;
  if (end <= start) {
    state.currentSession = null;
    return false;
  }

  const duration = Math.max(0, Math.round((end - start) / 1000));
  const classification = classifyDomain(session.domain, state.settings || {});

  addUsageSeconds(state, start, end, session.domain);
  addStatSeconds(state, start, end, 'activeSeconds');
  if (classification === 'productive') {
    addStatSeconds(state, start, end, 'productiveSeconds');
  } else if (classification === 'distracting') {
    addStatSeconds(state, start, end, 'distractingSeconds');
  }

  appendSegmentAndSummaries(state, {
    domain: session.domain,
    url: session.url,
    tabId: session.tabId,
    windowId: session.windowId,
    start,
    end,
    duration,
    reason,
    classification,
    productive: classification === 'productive'
  });

  state.currentSession = null;
  return true;
}

function finalizeIdleSession(state, endTime) {
  const session = state.currentSession;
  if (!session || !session.isIdle) {
    return false;
  }

  const start = session.idleStartedAt || session.lastActiveAt || endTime;
  const end = Math.max(endTime, start);
  if (end <= start) {
    state.currentSession = null;
    return false;
  }

  addStatSeconds(state, start, end, 'idleSeconds');
  state.currentSession = null;
  return true;
}

function beginActiveSession(state, context, startTime, options = {}) {
  const current = state.currentSession;
  const nowTime = startTime;

  if (current?.isIdle) {
    finalizeIdleSession(state, nowTime);
  }

  const activeSession = state.currentSession;
  if (activeSession && !activeSession.isIdle) {
    const sameContext =
      activeSession.tabId === context.tabId &&
      activeSession.windowId === context.windowId &&
      activeSession.domain === context.domain &&
      activeSession.url === context.url;

    if (sameContext) {
      activeSession.lastActiveAt = nowTime;
      return;
    }

    finalizeActiveSession(state, nowTime, options.reason || 'context-change');
  }

  state.currentSession = {
    tabId: context.tabId,
    windowId: context.windowId,
    domain: context.domain,
    url: context.url,
    title: context.title || '',
    startedAt: nowTime,
    lastActiveAt: nowTime,
    isIdle: false,
    source: options.reason || 'active'
  };
}

async function bootstrapFromFocusedContext() {
  // Reconcile on browser start so stale in-memory assumptions do not survive a restart.
  const state = await loadState();
  const nowTime = now();
  const idleState = await callIdleQueryState(IDLE_DETECTION_SECONDS);

  await saveState({
    ...state,
    currentSession: null,
    metadata: {
      ...(state.metadata || {}),
      lastReconciledAt: nowTime
    }
  });

  if (idleState !== 'active') {
    return;
  }

  const context = await getFocusedContext();
  if (!context) {
    return;
  }

  await mutateState(async (freshState) => {
    beginActiveSession(freshState, context, nowTime, { reason: 'bootstrap' });
    return freshState;
  });
}

async function handleInstalled() {
  await mutateState(async (state) => {
    state.settings = {
      ...state.settings
    };
    state.metadata = {
      ...(state.metadata || {}),
      lastReconciledAt: now()
    };
    return state;
  });

  callAlarmsCreate(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await callSetIdleDetectionInterval(IDLE_DETECTION_SECONDS);
  await bootstrapFromFocusedContext();
}

async function handleStartup() {
  callAlarmsCreate(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  await callSetIdleDetectionInterval(IDLE_DETECTION_SECONDS);
  await bootstrapFromFocusedContext();
}

async function handleActivated(activeInfo) {
  const context = await getTrackableContextForTab(activeInfo.tabId);
  const nowTime = now();

  if (!context) {
    await mutateState(async (state) => {
      if (state.currentSession && !state.currentSession.isIdle) {
        incrementDailyStat(state, localDayKeyFromTimestamp(nowTime), 'tabSwitches', 1);
        finalizeActiveSession(state, nowTime, 'tab-switch');
      }
      return state;
    });
    return;
  }

  await mutateState(async (state) => {
    if (state.currentSession && !state.currentSession.isIdle && state.currentSession.tabId !== context.tabId) {
      incrementDailyStat(state, localDayKeyFromTimestamp(nowTime), 'tabSwitches', 1);
    }
    beginActiveSession(state, context, nowTime, { reason: 'tab-activated' });
    return state;
  });
}

async function handleUpdated(tabId, changeInfo, tab) {
  if (!changeInfo || !changeInfo.url) {
    return;
  }

  const context = tab && tab.id === tabId && isTrackableUrl(changeInfo.url)
    ? {
        tabId: tab.id,
        windowId: tab.windowId,
        url: changeInfo.url,
        domain: normalizeDomain(extractDomainFromUrl(changeInfo.url)),
        title: tab.title || ''
      }
    : await getTrackableContextForTab(tabId).catch(() => null);

  const nowTime = now();
  await mutateState(async (state) => {
    const session = state.currentSession;
    if (session && !session.isIdle && session.tabId === tabId) {
      finalizeActiveSession(state, nowTime, 'url-change');
      incrementDailyStat(state, localDayKeyFromTimestamp(nowTime), 'pageNavigations', 1);
      if (context) {
        beginActiveSession(state, context, nowTime, { reason: 'url-change' });
      }
      return state;
    }

    if (context && state.currentSession && state.currentSession.isIdle) {
      beginActiveSession(state, context, nowTime, { reason: 'url-change' });
    }
    return state;
  });
}

async function handleWindowFocusChanged(windowId) {
  const nowTime = now();

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await mutateState(async (state) => {
      if (state.currentSession && !state.currentSession.isIdle) {
        finalizeActiveSession(state, nowTime, 'window-blur');
      }
      return state;
    });
    return;
  }

  const context = await getFocusedContext();
  await mutateState(async (state) => {
    incrementDailyStat(state, localDayKeyFromTimestamp(nowTime), 'windowFocusChanges', 1);
    if (context) {
      beginActiveSession(state, context, nowTime, { reason: 'window-focus' });
    } else if (state.currentSession && !state.currentSession.isIdle) {
      finalizeActiveSession(state, nowTime, 'non-trackable-focus');
    }
    return state;
  });
}

async function handleIdleStateChanged(newState) {
  const nowTime = now();

  if (newState === 'idle' || newState === 'locked') {
    await mutateState(async (state) => {
      if (state.currentSession && !state.currentSession.isIdle) {
        finalizeActiveSession(state, nowTime, newState);
      }

      state.currentSession = {
        tabId: null,
        windowId: null,
        domain: null,
        url: null,
        title: '',
        startedAt: nowTime,
        lastActiveAt: nowTime,
        idleStartedAt: nowTime,
        isIdle: true,
        source: newState
      };
      return state;
    });
    return;
  }

  const context = await getFocusedContext();
  await mutateState(async (state) => {
    if (state.currentSession && state.currentSession.isIdle) {
      finalizeIdleSession(state, nowTime);
    }

    if (context) {
      beginActiveSession(state, context, nowTime, { reason: 'idle-resume' });
    }
    return state;
  });
}

async function handleTabCreated() {
  await mutateState(async (state) => {
    incrementDailyStat(state, localDayKeyFromTimestamp(now()), 'tabOpens', 1);
    return state;
  });
}

async function handleTabRemoved(tabId) {
  const nowTime = now();
  await mutateState(async (state) => {
    incrementDailyStat(state, localDayKeyFromTimestamp(nowTime), 'tabCloses', 1);
    if (state.currentSession && !state.currentSession.isIdle && state.currentSession.tabId === tabId) {
      finalizeActiveSession(state, nowTime, 'tab-close');
    }
    return state;
  });
}

async function handleAlarm(alarm) {
  if (alarm.name !== HEARTBEAT_ALARM) {
    return;
  }

  const nowTime = now();
  const idleState = await callIdleQueryState(IDLE_DETECTION_SECONDS).catch(() => 'active');
  const context = await getFocusedContext().catch(() => null);

  await mutateState(async (state) => {
    state.metadata = {
      ...(state.metadata || {}),
      lastAlarmAt: nowTime
    };

    if (state.currentSession && state.currentSession.isIdle) {
      if (idleState === 'active') {
        finalizeIdleSession(state, nowTime);
        if (context) {
          beginActiveSession(state, context, nowTime, { reason: 'heartbeat-resume' });
        }
      }
      return state;
    }

    if (idleState !== 'active') {
      if (state.currentSession) {
        finalizeActiveSession(state, nowTime, idleState);
      }
      state.currentSession = {
        tabId: null,
        windowId: null,
        domain: null,
        url: null,
        title: '',
        startedAt: nowTime,
        lastActiveAt: nowTime,
        idleStartedAt: nowTime,
        isIdle: true,
        source: idleState
      };
      return state;
    }

    if (context) {
      beginActiveSession(state, context, nowTime, { reason: 'heartbeat' });
    } else if (state.currentSession && !state.currentSession.isIdle) {
      finalizeActiveSession(state, nowTime, 'no-trackable-context');
    }

    return state;
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstalled(details).catch((error) => console.error('Focus Analytics install failed', error));
});

chrome.runtime.onStartup.addListener(() => {
  void handleStartup().catch((error) => console.error('Focus Analytics startup failed', error));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void handleActivated(activeInfo).catch((error) => console.error('Focus Analytics tab activation failed', error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleUpdated(tabId, changeInfo, tab).catch((error) => console.error('Focus Analytics tab update failed', error));
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void handleWindowFocusChanged(windowId).catch((error) => console.error('Focus Analytics focus change failed', error));
});

chrome.idle.onStateChanged.addListener((state) => {
  void handleIdleStateChanged(state).catch((error) => console.error('Focus Analytics idle state failed', error));
});

chrome.tabs.onCreated.addListener(() => {
  void handleTabCreated().catch((error) => console.error('Focus Analytics tab create failed', error));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId).catch((error) => console.error('Focus Analytics tab removal failed', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void handleAlarm(alarm).catch((error) => console.error('Focus Analytics alarm failed', error));
});
