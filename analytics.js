import {
  localDayKey,
  localDayKeyFromTimestamp,
  toReadableMinutes
} from './storage.js';

function normalizeRule(rule) {
  return String(rule || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

export function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');
}

export function extractDomainFromUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    const host = parsed.hostname.toLowerCase();
    if (!host) {
      return null;
    }

    if (/^localhost$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return host;
    }

    const parts = host.replace(/^www\./, '').split('.');
    if (parts.length <= 2) {
      return parts.join('.');
    }

    const last = parts[parts.length - 1];
    const secondLast = parts[parts.length - 2];
    const thirdLast = parts[parts.length - 3];

    if (last.length === 2 && secondLast.length <= 3 && thirdLast) {
      return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
  } catch {
    return null;
  }
}

export function matchesDomainRule(domain, rule) {
  const cleanDomain = normalizeDomain(domain);
  const cleanRule = normalizeRule(rule);
  if (!cleanDomain || !cleanRule) {
    return false;
  }
  return cleanDomain === cleanRule || cleanDomain.endsWith(`.${cleanRule}`);
}

export function classifyDomain(domain, settings) {
  if (!domain) {
    return 'neutral';
  }

  if ((settings?.productiveDomains || []).some((rule) => matchesDomainRule(domain, rule))) {
    return 'productive';
  }

  if ((settings?.distractingDomains || []).some((rule) => matchesDomainRule(domain, rule))) {
    return 'distracting';
  }

  return 'neutral';
}

export function isTrackableUrl(url) {
  return Boolean(extractDomainFromUrl(url));
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }

  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }

  return `${secs}s`;
}

export function formatScore(score) {
  return `${Math.max(0, Math.min(100, Math.round(score || 0)))} / 100`;
}

export function getLastNDays(referenceDate, dayCount) {
  const days = [];
  const cursor = new Date(referenceDate);
  cursor.setHours(0, 0, 0, 0);

  for (let i = dayCount - 1; i >= 0; i -= 1) {
    const day = new Date(cursor);
    day.setDate(cursor.getDate() - i);
    days.push(localDayKey(day));
  }

  return days;
}

export function buildUsageSeries(state, dayKeys) {
  return dayKeys.map((dayKey) => ({
    dayKey,
    usage: state.dailyUsage[dayKey] || {},
    stats: state.dailyStats[dayKey] || null,
    focus: state.focusSessions[dayKey] || null
  }));
}

export function buildTopSites(dayUsage, limit = 8) {
  return Object.entries(dayUsage || {})
    .map(([domain, seconds]) => ({ domain, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

export function getUsageBreakdown(dayUsage, settings) {
  const productive = [];
  const distracting = [];
  const neutral = [];

  for (const [domain, seconds] of Object.entries(dayUsage || {})) {
    const item = { domain, seconds };
    const classification = classifyDomain(domain, settings);
    if (classification === 'productive') {
      productive.push(item);
    } else if (classification === 'distracting') {
      distracting.push(item);
    } else {
      neutral.push(item);
    }
  }

  const total = [...productive, ...distracting, ...neutral].reduce((sum, item) => sum + item.seconds, 0);
  const productiveSeconds = productive.reduce((sum, item) => sum + item.seconds, 0);
  const distractingSeconds = distracting.reduce((sum, item) => sum + item.seconds, 0);

  return {
    total,
    productiveSeconds,
    distractingSeconds,
    productive,
    distracting,
    neutral
  };
}

export function computeFocusSummaryFromSegments(segments, settings) {
  const productiveSegments = (segments || [])
    .filter((segment) => classifyDomain(segment.domain, settings) === 'productive')
    .slice()
    .sort((a, b) => a.start - b.start);

  const graceMs = Math.max(0, Number(settings?.interruptionGraceSeconds || 30)) * 1000;
  const minDurationSeconds = Math.max(1, Number(settings?.focusSessionMinMinutes || 25)) * 60;

  const sessions = [];
  let current = null;

  for (const segment of productiveSegments) {
    if (!current) {
      current = {
        start: segment.start,
        end: segment.end,
        duration: segment.duration || Math.max(0, Math.round((segment.end - segment.start) / 1000)),
        domains: new Set([segment.domain])
      };
      continue;
    }

    const gap = segment.start - current.end;
    if (gap <= graceMs) {
      current.end = Math.max(current.end, segment.end);
      current.duration += segment.duration || Math.max(0, Math.round((segment.end - segment.start) / 1000));
      current.domains.add(segment.domain);
      continue;
    }

    if (current.duration >= minDurationSeconds) {
      sessions.push({
        start: current.start,
        end: current.end,
        duration: current.duration,
        domainCount: current.domains.size
      });
    }

    current = {
      start: segment.start,
      end: segment.end,
      duration: segment.duration || Math.max(0, Math.round((segment.end - segment.start) / 1000)),
      domains: new Set([segment.domain])
    };
  }

  if (current && current.duration >= minDurationSeconds) {
    sessions.push({
      start: current.start,
      end: current.end,
      duration: current.duration,
      domainCount: current.domains.size
    });
  }

  const totalDuration = sessions.reduce((sum, session) => sum + session.duration, 0);
  const longestDuration = sessions.reduce((max, session) => Math.max(max, session.duration), 0);

  return {
    count: sessions.length,
    totalDuration,
    averageDuration: sessions.length ? totalDuration / sessions.length : 0,
    longestDuration,
    sessions
  };
}

export function computeProductivityScore(state, dayKey) {
  const settings = state.settings || {};
  const stats = state.dailyStats[dayKey] || {};
  const usage = state.dailyUsage[dayKey] || {};
  const breakdown = getUsageBreakdown(usage, settings);
  const focusSummary = state.focusSessions[dayKey] || computeFocusSummaryFromSegments(state.segments[dayKey] || [], settings);

  const activeSeconds = Math.max(1, stats.activeSeconds || breakdown.total || 0);
  const productiveRatio = breakdown.productiveSeconds / activeSeconds;
  const distractionRatio = breakdown.distractingSeconds / activeSeconds;
  const tabSwitchesPerHour = (stats.tabSwitches || 0) / Math.max(1, activeSeconds / 3600);
  const switchPenalty = Math.min(1, tabSwitchesPerHour / Math.max(1, settings.scoreWeights?.switchSaturationPerHour || 20));
  const averageFocusMinutes = toReadableMinutes(focusSummary.averageDuration || 0);
  const focusBonus = Math.min(1, averageFocusMinutes / Math.max(1, settings.scoreWeights?.focusTargetMinutes || 50));

  const weights = settings.scoreWeights || {};
  const productiveWeight = Number(weights.productiveRatio ?? 0.55);
  const focusWeight = Number(weights.focusBonus ?? 0.2);
  const switchWeight = Number(weights.switchPenalty ?? 0.15);
  const distractionWeight = Number(weights.distractionPenalty ?? 0.1);

  const normalized =
    (productiveWeight * productiveRatio) +
    (focusWeight * focusBonus) -
    (switchWeight * switchPenalty) -
    (distractionWeight * distractionRatio);

  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

export function buildDailyModel(state, dayKey) {
  const stats = state.dailyStats[dayKey] || {};
  const usage = state.dailyUsage[dayKey] || {};
  const focusSummary = state.focusSessions[dayKey] || computeFocusSummaryFromSegments(state.segments[dayKey] || [], state.settings || {});
  const score = computeProductivityScore(state, dayKey);
  const topSites = buildTopSites(usage, 8);
  const breakdown = getUsageBreakdown(usage, state.settings || {});

  return {
    dayKey,
    stats,
    usage,
    focusSummary,
    score,
    topSites,
    breakdown
  };
}

export function buildWeeklyModel(state, referenceDate = new Date()) {
  const dayKeys = getLastNDays(referenceDate, 7);
  const days = dayKeys.map((dayKey) => buildDailyModel(state, dayKey));
  const totalActiveSeconds = days.reduce((sum, day) => sum + (day.stats.activeSeconds || 0), 0);
  const totalTabSwitches = days.reduce((sum, day) => sum + (day.stats.tabSwitches || 0), 0);
  const totalIdleSeconds = days.reduce((sum, day) => sum + (day.stats.idleSeconds || 0), 0);
  const focusSessions = days.reduce((sum, day) => sum + (day.focusSummary.count || 0), 0);
  const score = days.length ? Math.round(days.reduce((sum, day) => sum + day.score, 0) / days.length) : 0;

  return {
    dayKeys,
    days,
    totalActiveSeconds,
    totalTabSwitches,
    totalIdleSeconds,
    focusSessions,
    score
  };
}

export function buildHeatmapMatrix(state, referenceDate = new Date()) {
  const dayKeys = getLastNDays(referenceDate, 7);
  const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));

  for (let dayIndex = 0; dayIndex < dayKeys.length; dayIndex += 1) {
    const dayKey = dayKeys[dayIndex];
    const segments = state.segments[dayKey] || [];
    for (const segment of segments) {
      const start = new Date(segment.start);
      const end = new Date(segment.end);
      let cursor = new Date(start);
      while (cursor < end) {
        const nextHour = new Date(cursor);
        nextHour.setMinutes(60, 0, 0);
        const chunkEnd = nextHour < end ? nextHour : end;
        const hour = cursor.getHours();
        const seconds = Math.max(0, (chunkEnd.getTime() - cursor.getTime()) / 1000);
        matrix[dayIndex][hour] += seconds;
        cursor = chunkEnd;
      }
    }
  }

  return matrix;
}

export function buildInsights(state, referenceDate = new Date()) {
  const dayKeys = getLastNDays(referenceDate, 7);
  const allSegments = dayKeys.flatMap((dayKey) => (state.segments[dayKey] || []).map((segment) => ({ ...segment, dayKey })));
  const allSessions = dayKeys.reduce((sum, dayKey) => sum + ((state.focusSessions[dayKey]?.count) || 0), 0);

  if (dayKeys.length < 7 || allSegments.length < 20 || allSessions < 20) {
    return [];
  }

  const productiveSwitches = new Map();
  const distractingSwitches = new Map();
  const distractionHours = Array.from({ length: 24 }, () => 0);
  const weekdayFocus = Array.from({ length: 7 }, () => ({ count: 0, total: 0, longest: 0 }));

  for (const segment of allSegments) {
    const classification = classifyDomain(segment.domain, state.settings || {});

    if (segment.reason === 'tab-switch') {
      const map = classification === 'distracting' ? distractingSwitches : productiveSwitches;
      map.set(segment.domain, (map.get(segment.domain) || 0) + 1);
    }

    if (classification === 'distracting') {
      distractionHours[new Date(segment.start).getHours()] += segment.duration || 0;
    }
  }

  for (const dayKey of dayKeys) {
    const focus = state.focusSessions[dayKey];
    if (!focus || !focus.sessions) {
      continue;
    }

    const weekday = new Date(`${dayKey}T00:00:00`).getDay();
    weekdayFocus[weekday].count += focus.count || 0;
    weekdayFocus[weekday].total += focus.totalDuration || 0;
    weekdayFocus[weekday].longest = Math.max(weekdayFocus[weekday].longest, focus.longestDuration || 0);
  }

  const insights = [];

  const topDistracting = Array.from(distractingSwitches.entries()).sort((a, b) => b[1] - a[1])[0];
  const topProductive = Array.from(productiveSwitches.entries()).sort((a, b) => b[1] - a[1])[0];
  if (topDistracting && topProductive && topProductive[1] > 0) {
    const ratio = Math.max(1, Math.round(topDistracting[1] / topProductive[1]));
    insights.push(`You switch tabs ${ratio}x more often on ${topDistracting[0]} than on ${topProductive[0]}.`);
  }

  const peakWindow = distractionHours.map((_, hour) => ({
    hour,
    total: distractionHours[hour] + distractionHours[(hour + 1) % 24]
  })).sort((a, b) => b.total - a.total)[0];
  if (peakWindow && peakWindow.total > 0) {
    const formatHour = (hour) => {
      const normalized = ((hour % 24) + 24) % 24;
      const suffix = normalized >= 12 ? 'PM' : 'AM';
      const display = normalized % 12 || 12;
      return `${display} ${suffix}`;
    };
    insights.push(`Most distractions occur between ${formatHour(peakWindow.hour)} and ${formatHour(peakWindow.hour + 2)}.`);
  }

  const bestWeekday = weekdayFocus
    .map((item, weekday) => ({ weekday, longest: item.longest }))
    .sort((a, b) => b.longest - a.longest)[0];
  if (bestWeekday && bestWeekday.longest > 0) {
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    insights.push(`Your longest focus sessions happen on ${weekdayNames[bestWeekday.weekday]}s.`);
  }

  return insights;
}

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsvExport(state, options = {}) {
  const rows = [];
  rows.push(['recordType', 'dayKey', 'domain', 'metric', 'value', 'start', 'end', 'duration', 'url', 'tabId', 'windowId', 'reason'].map(csvCell).join(','));

  if (options.includeUsage !== false) {
    for (const [dayKey, usage] of Object.entries(state.dailyUsage || {})) {
      for (const [domain, seconds] of Object.entries(usage || {})) {
        rows.push(['usage', dayKey, domain, 'seconds', seconds, '', '', '', '', '', '', ''].map(csvCell).join(','));
      }
    }
  }

  for (const [dayKey, stats] of Object.entries(state.dailyStats || {})) {
    for (const [metric, value] of Object.entries(stats || {})) {
      rows.push(['stat', dayKey, '', metric, value, '', '', '', '', '', '', ''].map(csvCell).join(','));
    }
  }

  if (options.includeSegments !== false) {
    for (const [dayKey, segments] of Object.entries(state.segments || {})) {
      for (const segment of segments || []) {
        rows.push([
          'segment',
          dayKey,
          segment.domain || '',
          'seconds',
          segment.duration || 0,
          segment.start || '',
          segment.end || '',
          segment.duration || 0,
          segment.url || '',
          segment.tabId ?? '',
          segment.windowId ?? '',
          segment.reason || ''
        ].map(csvCell).join(','));
      }
    }
  }

  if (options.includeFocusSessions !== false) {
    for (const [dayKey, focus] of Object.entries(state.focusSessions || {})) {
      rows.push(['focusSummary', dayKey, '', 'count', focus.count || 0, '', '', '', '', '', '', ''].map(csvCell).join(','));
      rows.push(['focusSummary', dayKey, '', 'averageDuration', Math.round(focus.averageDuration || 0), '', '', '', '', '', '', ''].map(csvCell).join(','));
      rows.push(['focusSummary', dayKey, '', 'longestDuration', Math.round(focus.longestDuration || 0), '', '', '', '', '', '', ''].map(csvCell).join(','));
    }
  }

  return rows.join('\n');
}

export function buildJsonExport(state, options = {}) {
  return {
    exportedAt: Date.now(),
    schemaVersion: state.schemaVersion,
    settings: options.includeSettings === false ? undefined : state.settings,
    dailyUsage: state.dailyUsage,
    dailyStats: state.dailyStats,
    segments: options.includeSegments === false ? undefined : state.segments,
    focusSessions: options.includeFocusSessions === false ? undefined : state.focusSessions,
    insights: options.includeInsights === false ? [] : buildInsights(state),
    metadata: state.metadata
  };
}

export function buildDashboardModel(state, referenceDate = new Date()) {
  const todayKey = localDayKey(referenceDate);
  const weekly = buildWeeklyModel(state, referenceDate);
  const today = buildDailyModel(state, todayKey);
  const insights = buildInsights(state, referenceDate);
  const heatmap = buildHeatmapMatrix(state, referenceDate);

  return {
    today,
    weekly,
    insights,
    heatmap
  };
}
