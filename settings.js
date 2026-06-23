import { DEFAULT_SETTINGS, createDefaultState, loadState, localDayKey, mutateState } from './storage.js';
import { buildCsvExport, buildJsonExport } from './analytics.js';

const els = {};

function $(id) {
  return document.getElementById(id);
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

function parseDomainList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function populateForm(settings) {
  els.productiveDomains.value = (settings.productiveDomains || []).join('\n');
  els.distractingDomains.value = (settings.distractingDomains || []).join('\n');
  els.focusSessionMinMinutes.value = settings.focusSessionMinMinutes ?? DEFAULT_SETTINGS.focusSessionMinMinutes;
  els.interruptionGraceSeconds.value = settings.interruptionGraceSeconds ?? DEFAULT_SETTINGS.interruptionGraceSeconds;
  els.includeSegments.checked = settings.export?.includeSegments ?? true;
  els.includeFocusSessions.checked = settings.export?.includeFocusSessions ?? true;
  els.includeInsights.checked = settings.export?.includeInsights ?? true;
  els.includeSettings.checked = settings.export?.includeSettings ?? true;
}

function readForm() {
  return {
    productiveDomains: parseDomainList(els.productiveDomains.value),
    distractingDomains: parseDomainList(els.distractingDomains.value),
    focusSessionMinMinutes: Number(els.focusSessionMinMinutes.value) || DEFAULT_SETTINGS.focusSessionMinMinutes,
    interruptionGraceSeconds: Number(els.interruptionGraceSeconds.value) || DEFAULT_SETTINGS.interruptionGraceSeconds,
    export: {
      includeSegments: els.includeSegments.checked,
      includeFocusSessions: els.includeFocusSessions.checked,
      includeInsights: els.includeInsights.checked,
      includeSettings: els.includeSettings.checked
    },
    scoreWeights: DEFAULT_SETTINGS.scoreWeights
  };
}

function showStatus(message, kind = 'success') {
  els.settingsStatus.hidden = false;
  els.settingsStatus.textContent = message;
  els.settingsStatus.className = kind === 'error' ? 'notice error' : 'notice success';
}

async function loadSettings() {
  const state = await loadState();
  populateForm(state.settings || DEFAULT_SETTINGS);
}

async function saveSettings() {
  const settings = readForm();
  await mutateState(async (state) => ({
    ...state,
    settings: {
      ...(state.settings || DEFAULT_SETTINGS),
      ...settings
    }
  }));
  showStatus('Settings saved.', 'success');
}

async function resetDefaults() {
  await mutateState(async (state) => ({
    ...state,
    settings: { ...createDefaultState().settings }
  }));
  await loadSettings();
  showStatus('Defaults restored.', 'success');
}

async function exportData(type) {
  const state = await loadState();
  const options = state.settings?.export || {};
  if (type === 'csv') {
    const csv = buildCsvExport(state, options);
    downloadFile(`focus-analytics-${localDayKey()}.csv`, csv, 'text/csv');
    return;
  }

  const json = JSON.stringify(buildJsonExport(state, options), null, 2);
  downloadFile(`focus-analytics-${localDayKey()}.json`, json, 'application/json');
}

function wireEvents() {
  els.saveSettingsButton.addEventListener('click', () => saveSettings().catch((error) => showStatus(error.message, 'error')));
  els.resetDefaultsButton.addEventListener('click', () => resetDefaults().catch((error) => showStatus(error.message, 'error')));
  els.exportCsvButton.addEventListener('click', () => exportData('csv').catch((error) => showStatus(error.message, 'error')));
  els.exportJsonButton.addEventListener('click', () => exportData('json').catch((error) => showStatus(error.message, 'error')));
}

async function bootstrap() {
  [
    'productiveDomains',
    'distractingDomains',
    'focusSessionMinMinutes',
    'interruptionGraceSeconds',
    'includeSegments',
    'includeFocusSessions',
    'includeInsights',
    'includeSettings',
    'saveSettingsButton',
    'exportCsvButton',
    'exportJsonButton',
    'resetDefaultsButton',
    'settingsStatus'
  ].forEach((id) => {
    els[id] = $(id);
  });

  wireEvents();
  await loadSettings();
}

bootstrap().catch((error) => {
  console.error(error);
  showStatus('Unable to load settings.', 'error');
});
