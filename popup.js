import { loadState, localDayKey } from './storage.js';
import { buildDashboardModel, buildJsonExport, formatDuration, formatScore } from './analytics.js';

const els = {};

function $(id) {
  return document.getElementById(id);
}

function openPage(page) {
  if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: chrome.runtime.getURL(page) });
  } else {
    window.open(page, '_blank');
  }
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

async function exportJson() {
  const state = await loadState();
  const json = JSON.stringify(buildJsonExport(state, state.settings?.export || {}), null, 2);
  downloadFile(`focus-analytics-${localDayKey()}.json`, json, 'application/json');
}

async function refreshPopup() {
  const state = await loadState();
  const model = buildDashboardModel(state);
  const today = model.today;

  els.popupDomain.textContent = state.currentSession?.domain ? `Tracking ${state.currentSession.domain}` : 'Watching active browsing only';
  els.popupToday.textContent = formatDuration(today.stats?.activeSeconds || 0);
  els.popupScore.textContent = formatScore(today.score || 0);
  els.popupSwitches.textContent = String(today.stats?.tabSwitches || 0);
  els.popupFocus.textContent = String(today.focusSummary?.count || 0);
}

function wireEvents() {
  els.openDashboardButton.addEventListener('click', () => openPage('dashboard.html'));
  els.openSettingsButton.addEventListener('click', () => openPage('settings.html'));
  els.exportJsonButton.addEventListener('click', () => exportJson().catch(console.error));
}

async function bootstrap() {
  ['popupDomain', 'popupToday', 'popupScore', 'popupSwitches', 'popupFocus', 'openDashboardButton', 'openSettingsButton', 'exportJsonButton'].forEach((id) => {
    els[id] = $(id);
  });
  wireEvents();
  await refreshPopup();
}

bootstrap().catch((error) => {
  console.error(error);
});
