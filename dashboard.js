import { loadState, localDayKey } from './storage.js';
import {
  buildCsvExport,
  buildDashboardModel,
  buildJsonExport,
  formatDuration,
  formatScore
} from './analytics.js';

const els = {};
const CANVAS_FONT = '"Trebuchet MS", "Aptos", sans-serif';

function $(id) {
  return document.getElementById(id);
}

function initElements() {
  [
    'statusPill',
    'heroTitle',
    'heroSubtitle',
    'coverageText',
    'todayActive',
    'todayActiveDelta',
    'weeklyActive',
    'weeklyActiveDelta',
    'tabSwitches',
    'tabSwitchDelta',
    'idleTime',
    'idleDelta',
    'productivityScore',
    'scoreDelta',
    'focusSessions',
    'focusDelta',
    'topSitesList',
    'insightsList',
    'usagePieChart',
    'productivityBarChart',
    'weeklyLineChart',
    'heatmapCanvas',
    'refreshButton',
    'exportCsvButton',
    'exportJsonButton',
    'openPopupButton',
    'openSettingsButton'
  ].forEach((id) => {
    els[id] = $(id);
  });
}

function formatListValue(seconds) {
  return formatDuration(seconds || 0);
}

function downloadFile(filename, contents, mimeType) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderList(container, items, emptyText, itemRenderer) {
  container.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = emptyText;
    container.appendChild(li);
    return;
  }

  items.forEach((item, index) => {
    container.appendChild(itemRenderer(item, index));
  });
}

function formatDayLabel(dayKey) {
  const date = new Date(`${dayKey}T00:00:00`);
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function toCanvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawPieChart(canvas, items) {
  const { ctx, width, height } = toCanvasContext(canvas);
  ctx.clearRect(0, 0, width, height);

  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `14px ${CANVAS_FONT}`;
    ctx.fillText('No usage yet', 16, 24);
    return;
  }

  const cx = width / 2;
  const cy = height / 2 + 4;
  const radius = Math.min(width, height) * 0.32;
  let angle = -Math.PI / 2;

  items.forEach((item) => {
    const slice = (item.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = item.color;
    ctx.fill();
    angle += slice;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(8, 16, 22, 0.95)';
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'center';
  ctx.font = `700 20px ${CANVAS_FONT}`;
  ctx.fillText(`${Math.round(total / 3600)}h`, cx, cy - 2);
  ctx.font = `12px ${CANVAS_FONT}`;
  ctx.fillStyle = 'rgba(145,166,178,0.95)';
  ctx.fillText('active', cx, cy + 18);
}

function drawBarChart(canvas, items) {
  const { ctx, width, height } = toCanvasContext(canvas);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 18, right: 16, bottom: 30, left: 28 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const max = Math.max(100, ...items.map((item) => item.value || 0));

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  items.forEach((item, index) => {
    const x = padding.left + (chartWidth / items.length) * index + 6;
    const barWidth = Math.max(16, chartWidth / items.length - 12);
    const barHeight = (item.value / max) * chartHeight;
    const y = padding.top + chartHeight - barHeight;

    const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
    gradient.addColorStop(0, 'rgba(120, 214, 177, 0.95)');
    gradient.addColorStop(1, 'rgba(51, 193, 141, 0.55)');
    ctx.fillStyle = gradient;
    drawRoundedRect(ctx, x, y, barWidth, barHeight, 8);
    ctx.fill();

    ctx.fillStyle = 'rgba(234, 244, 247, 0.85)';
    ctx.font = `12px ${CANVAS_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(item.label), x + barWidth / 2, height - 10);
  });
}

function drawLineChart(canvas, items) {
  const { ctx, width, height } = toCanvasContext(canvas);
  ctx.clearRect(0, 0, width, height);

  const padding = { top: 18, right: 18, bottom: 28, left: 32 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const max = Math.max(1, ...items.map((item) => item.value || 0));

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  if (!items.length) {
    return;
  }

  const points = items.map((item, index) => {
    const x = padding.left + (chartWidth / Math.max(1, items.length - 1)) * index;
    const y = padding.top + chartHeight - (item.value / max) * chartHeight;
    return { x, y, item };
  });

  const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
  gradient.addColorStop(0, 'rgba(120, 214, 177, 0.34)');
  gradient.addColorStop(1, 'rgba(120, 214, 177, 0.02)');

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(points[points.length - 1].x, height - padding.bottom);
  ctx.lineTo(points[0].x, height - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = 'rgba(120, 214, 177, 0.95)';
  ctx.lineWidth = 3;
  ctx.stroke();

  points.forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#effaf5';
    ctx.fill();
  });

  ctx.fillStyle = 'rgba(234, 244, 247, 0.85)';
  ctx.font = `12px ${CANVAS_FONT}`;
  ctx.textAlign = 'center';
  points.forEach((point) => {
    ctx.fillText(String(point.item.label), point.x, height - 10);
  });
}

function drawHeatmap(canvas, matrix, dayKeys = []) {
  const { ctx, width, height } = toCanvasContext(canvas);
  ctx.clearRect(0, 0, width, height);

  const rows = matrix.length;
  const cols = matrix[0]?.length || 24;
  const paddingLeft = 54;
  const paddingTop = 22;
  const cellWidth = (width - paddingLeft - 8) / cols;
  const cellHeight = (height - paddingTop - 16) / rows;
  const max = Math.max(1, ...matrix.flat());
  const dayLabels = dayKeys.length
    ? dayKeys.map((dayKey) => new Date(`${dayKey}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' }))
    : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  ctx.fillStyle = 'rgba(145,166,178,0.85)';
  ctx.font = `11px ${CANVAS_FONT}`;
  ctx.textAlign = 'right';

  dayLabels.forEach((label, index) => {
    const y = paddingTop + index * cellHeight + cellHeight * 0.68;
    ctx.fillText(label, paddingLeft - 8, y);
  });

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = matrix[row][col] || 0;
      const intensity = value / max;
      const x = paddingLeft + col * cellWidth;
      const y = paddingTop + row * cellHeight;
      ctx.fillStyle = `rgba(120, 214, 177, ${0.08 + intensity * 0.86})`;
      drawRoundedRect(ctx, x + 1, y + 1, Math.max(1, cellWidth - 2), Math.max(1, cellHeight - 2), 4);
      ctx.fill();
    }
  }
}

function buildPieItems(dayUsage) {
  const colors = ['#78d6b1', '#5db2ff', '#f5c26b', '#f28b82', '#d8a4ff', '#6cdbff'];
  const items = Object.entries(dayUsage || {})
    .map(([domain, value]) => ({ domain, value }))
    .sort((a, b) => b.value - a.value);

  const top = items.slice(0, 5);
  const rest = items.slice(5).reduce((sum, item) => sum + item.value, 0);
  if (rest > 0) {
    top.push({ domain: 'Other', value: rest });
  }

  return top.map((item, index) => ({
    label: item.domain.length > 10 ? `${item.domain.slice(0, 10)}…` : item.domain,
    value: item.value,
    color: colors[index % colors.length]
  }));
}

function openExtensionPage(page) {
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  } else {
    window.open(page, '_blank');
  }
}

async function exportCurrent(type) {
  const state = await loadState();
  const options = state.settings?.export || {};

  if (type === 'csv') {
    const csv = buildCsvExport(state, {
      includeSegments: options.includeSegments,
      includeFocusSessions: options.includeFocusSessions
    });
    downloadFile(`focus-analytics-${localDayKey()}.csv`, csv, 'text/csv');
    return;
  }

  const json = JSON.stringify(buildJsonExport(state, options), null, 2);
  downloadFile(`focus-analytics-${localDayKey()}.json`, json, 'application/json');
}

function setMetric(id, value, delta = '\u00a0') {
  els[id].textContent = value;
  if (els[`${id}Delta`]) {
    els[`${id}Delta`].textContent = delta;
  }
}

function renderDashboard(state) {
  const model = buildDashboardModel(state);
  const { today, weekly, insights, heatmap } = model;
  const todayUsage = today.usage || {};
  const todayStats = today.stats || {};

  els.statusPill.textContent = state.currentSession?.isIdle ? 'System idle' : state.currentSession ? `Tracking ${state.currentSession.domain}` : 'Waiting for active browsing';
  els.heroTitle.textContent = state.currentSession?.domain ? `Tracking ${state.currentSession.domain}` : 'Today\'s focus view';
  els.heroSubtitle.textContent = state.currentSession?.isIdle
    ? 'The extension is paused while the user is idle or locked.'
    : 'Active time, focus sessions, productivity, and the sites shaping your attention.';

  els.coverageText.textContent = `${Object.keys(state.dailyStats || {}).length} days tracked, ${(Object.values(state.segments || {}).flat().length)} browsing segments captured.`;

  setMetric('todayActive', formatListValue(todayStats.activeSeconds || 0));
  setMetric('weeklyActive', formatListValue(weekly.totalActiveSeconds || 0));
  setMetric('tabSwitches', String(todayStats.tabSwitches || 0));
  setMetric('idleTime', formatListValue(todayStats.idleSeconds || 0));
  setMetric('productivityScore', formatScore(today.score || 0));
  setMetric('focusSessions', String(today.focusSummary?.count || 0));

  els.todayActiveDelta.textContent = `${today.topSites[0]?.domain || 'No site yet'}`;
  els.weeklyActiveDelta.textContent = `${weekly.totalTabSwitches || 0} weekly switches`;
  els.tabSwitchDelta.textContent = `${todayStats.windowFocusChanges || 0} window focus changes`;
  els.idleDelta.textContent = `${Math.round(((todayStats.idleSeconds || 0) / Math.max(1, (todayStats.activeSeconds || 0) + (todayStats.idleSeconds || 0))) * 100)}% of tracked time`;
  els.scoreDelta.textContent = 'Rule-based score';
  els.focusDelta.textContent = `${formatDuration(today.focusSummary?.averageDuration || 0)} avg`;

  renderList(els.topSitesList, today.topSites, 'No browsing history yet.', (item, index) => {
    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `<div><strong>${index + 1}. ${item.domain}</strong><span>${formatDuration(item.seconds)}</span></div><span class="badge muted">${Math.round((item.seconds / Math.max(1, todayStats.activeSeconds || item.seconds)) * 100)}%</span>`;
    return li;
  });

  renderList(els.insightsList, insights, 'Not enough historical data yet. Keep browsing for at least 7 days and 20 sessions.', (item) => {
    const li = document.createElement('li');
    li.className = 'list-item';
    li.innerHTML = `<div><strong>${item}</strong><span>Rule-based observation</span></div><span class="badge">Insight</span>`;
    return li;
  });

  const pieItems = buildPieItems(todayUsage);
  drawPieChart(els.usagePieChart, pieItems);

  const productivityBars = weekly.days.map((day) => ({
    label: formatDayLabel(day.dayKey),
    value: day.score || 0
  }));
  drawBarChart(els.productivityBarChart, productivityBars);

  const activityLine = weekly.days.map((day) => ({
    label: formatDayLabel(day.dayKey),
    value: (day.stats?.activeSeconds || 0) / 3600
  }));
  drawLineChart(els.weeklyLineChart, activityLine);

  drawHeatmap(els.heatmapCanvas, heatmap, weekly.dayKeys);
}

async function refresh() {
  const state = await loadState();
  renderDashboard(state);
}

function wireEvents() {
  els.refreshButton.addEventListener('click', refresh);
  els.exportCsvButton.addEventListener('click', () => exportCurrent('csv'));
  els.exportJsonButton.addEventListener('click', () => exportCurrent('json'));
  els.openPopupButton.addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    } else {
      window.open('popup.html', '_blank');
    }
  });
  els.openSettingsButton.addEventListener('click', () => openExtensionPage('settings.html'));
}

function observeChartResize() {
  window.addEventListener('resize', () => {
    refresh().catch((error) => console.error(error));
  });
}

async function bootstrap() {
  initElements();
  wireEvents();
  observeChartResize();
  await refresh();
}

bootstrap().catch((error) => {
  console.error(error);
  els.statusPill.textContent = 'Unable to load data';
});
