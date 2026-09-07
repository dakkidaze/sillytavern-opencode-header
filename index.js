import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { yaml } from '../../../../lib.js';

const SETTINGS_KEY = 'ocgo_session_header';
const SESSION_VAR_KEY = 'ocgo_session_id';

const SES_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const UA_PRESETS = [
    { label: 'opencode/1.18.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14', value: 'opencode/1.18.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14' },
    { label: 'opencode/latest/1.3.15/cli', value: 'opencode/latest/1.3.15/cli' },
];

let sesLastMs = 0;
let sesCounter = 0;

function defaultSettings() {
    return {
        enabled: true,
        sessionMode: 'perChat',
        manualSessionId: '',
        randomSessionId: '',
        spoofUa: true,
        uaPresetIndex: 0,
        uaCustom: '',
    };
}

function getSettings() {
    const s = extension_settings[SETTINGS_KEY] || (extension_settings[SETTINGS_KEY] = {});
    const d = defaultSettings();
    for (const k of Object.keys(d)) {
        if (s[k] === undefined) {
            s[k] = Array.isArray(d[k]) ? [...d[k]] : (d[k] && typeof d[k] === 'object' ? { ...d[k] } : d[k]);
        }
    }
    return s;
}

function generateRotatingId() {
    const now = Date.now();
    if (now !== sesLastMs) { sesLastMs = now; sesCounter = 0; }
    sesCounter++;
    const n = ~(BigInt(now) * 0x1000n + BigInt(sesCounter));
    let hex = '';
    for (let i = 5; i >= 0; i--) {
        hex += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
    }
    const rand = new Uint8Array(14);
    crypto.getRandomValues(rand);
    let b62 = '';
    for (const v of rand) b62 += SES_ALPHABET[v % 62];
    return 'ses_' + hex + b62;
}

function isValidToken(value) {
    return /^[A-Za-z0-9_-]{10,80}$/.test(String(value || ''));
}

function getOrCreateSessionId() {
    const s = getSettings();
    if (s.sessionMode === 'manual') {
        if (!isValidToken(s.manualSessionId)) {
            s.manualSessionId = generateRotatingId();
            saveSettingsDebounced();
        }
        return s.manualSessionId;
    }
    if (s.sessionMode === 'random') {
        if (!isValidToken(s.randomSessionId)) {
            s.randomSessionId = generateRotatingId();
            saveSettingsDebounced();
        }
        return s.randomSessionId;
    }
    try {
        const context = getContext();
        const meta = context?.chatMetadata;
        if (meta && typeof meta === 'object') {
            if (isValidToken(meta[SESSION_VAR_KEY])) {
                return String(meta[SESSION_VAR_KEY]);
            }
            const sessionId = generateRotatingId();
            meta[SESSION_VAR_KEY] = sessionId;
            if (typeof context.saveMetadataDebounced === 'function') {
                context.saveMetadataDebounced();
            }
            return sessionId;
        }
    } catch {
        // fall through
    }
    return generateRotatingId();
}

function getUaValue() {
    const s = getSettings();
    if (s.uaCustom && s.uaCustom.trim()) {
        return s.uaCustom.trim();
    }
    const preset = UA_PRESETS[s.uaPresetIndex] || UA_PRESETS[0];
    return preset.value;
}

function parseHeadersYaml(text) {
    if (!text) return {};
    try {
        const parsed = yaml.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        if (Array.isArray(parsed)) {
            const headers = {};
            for (const item of parsed) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    Object.assign(headers, item);
                }
            }
            return headers;
        }
    } catch {
        return {};
    }
    return {};
}

function applyHeaders(generateData) {
    const s = getSettings();
    if (!s.enabled) return;
    const headers = parseHeadersYaml(generateData.custom_include_headers);
    headers['x-opencode-session'] = getOrCreateSessionId();
    if (s.spoofUa) {
        headers['user-agent'] = getUaValue();
    }
    generateData.custom_include_headers = yaml.stringify(headers);
}

function onSettingsReady(generateData) {
    eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
    if (!generateData || typeof generateData !== 'object') return;
    try {
        applyHeaders(generateData);
    } catch {
        // ignore
    }
}

eventSource.makeLast(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);

const TEMPLATE = `
<div id="ocgo_settings" class="ocgo-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>OpenCode Go Session Header</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input id="ocgo_enabled" type="checkbox" />
                <span>启用（注入 x-opencode-session）</span>
            </label>

            <label for="ocgo_mode">会话 ID 模式</label>
            <select id="ocgo_mode" class="text_pole">
                <option value="perChat">每聊天固定（推荐，缓存亲和）</option>
                <option value="random">全局随机</option>
                <option value="manual">手动填写</option>
            </select>
            <div id="ocgo_manual_row" style="display:none">
                <label for="ocgo_manual_id">手动会话 ID</label>
                <input id="ocgo_manual_id" class="text_pole" type="text" autocomplete="off" />
            </div>
            <div id="ocgo_random_row" style="display:none">
                <button id="ocgo_random_new" class="menu_button">随机换新</button>
            </div>
            <div id="ocgo_current_id" class="ocgo-info"></div>

            <label class="checkbox_label">
                <input id="ocgo_spoof_ua" type="checkbox" />
                <span>伪装 User-Agent 为 opencode 客户端</span>
            </label>
            <label for="ocgo_ua_preset">User-Agent 预设</label>
            <select id="ocgo_ua_preset" class="text_pole">
                <option value="0">opencode/1.18.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14</option>
                <option value="1">opencode/latest/1.3.15/cli</option>
            </select>
            <label for="ocgo_ua_custom">自定义 User-Agent（留空使用预设）</label>
            <input id="ocgo_ua_custom" class="text_pole" type="text" autocomplete="off" />
            <div id="ocgo_current_ua" class="ocgo-info"></div>
        </div>
    </div>
</div>
`;

function renderCurrent() {
    const idEl = document.getElementById('ocgo_current_id');
    if (idEl) {
        idEl.textContent = `当前会话 ID: ${getOrCreateSessionId()}`;
    }
    const uaEl = document.getElementById('ocgo_current_ua');
    if (uaEl) {
        uaEl.textContent = `当前 User-Agent: ${getUaValue()}`;
    }
}

function bindSettings() {
    const settings = getSettings();
    const el = (id) => document.getElementById(id);
    if (!el('ocgo_enabled')) return;

    el('ocgo_enabled').checked = !!settings.enabled;
    el('ocgo_enabled').addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettingsDebounced();
    });

    el('ocgo_mode').value = settings.sessionMode;
    const updateMode = () => {
        el('ocgo_manual_row').style.display = settings.sessionMode === 'manual' ? '' : 'none';
        el('ocgo_random_row').style.display = settings.sessionMode === 'random' ? '' : 'none';
        renderCurrent();
    };
    el('ocgo_mode').addEventListener('change', (e) => {
        settings.sessionMode = String(e.target.value);
        saveSettingsDebounced();
        updateMode();
    });

    el('ocgo_random_new').addEventListener('click', () => {
        settings.randomSessionId = generateRotatingId();
        saveSettingsDebounced();
        renderCurrent();
    });

    el('ocgo_manual_id').value = settings.manualSessionId || '';
    el('ocgo_manual_id').addEventListener('input', (e) => {
        settings.manualSessionId = String(e.target.value);
        saveSettingsDebounced();
        renderCurrent();
    });

    el('ocgo_spoof_ua').checked = !!settings.spoofUa;
    el('ocgo_spoof_ua').addEventListener('change', (e) => {
        settings.spoofUa = e.target.checked;
        saveSettingsDebounced();
        renderCurrent();
    });

    el('ocgo_ua_preset').value = String(settings.uaPresetIndex || 0);
    el('ocgo_ua_preset').addEventListener('change', (e) => {
        settings.uaPresetIndex = Number(e.target.value);
        saveSettingsDebounced();
        renderCurrent();
    });

    el('ocgo_ua_custom').value = settings.uaCustom || '';
    el('ocgo_ua_custom').addEventListener('input', (e) => {
        settings.uaCustom = String(e.target.value);
        saveSettingsDebounced();
        renderCurrent();
    });

    updateMode();
    setInterval(renderCurrent, 2000);
}

jQuery(() => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', TEMPLATE);
    bindSettings();
    console.log('[OpenCodeGoHeader] loaded.');
});