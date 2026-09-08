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

let pendingMessageId = null;
let pendingRequestId = null;

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

function generateId(prefix, descending) {
    const now = Date.now();
    if (now !== sesLastMs) { sesLastMs = now; sesCounter = 0; }
    sesCounter++;
    let n = BigInt(now) * 0x1000n + BigInt(sesCounter);
    if (descending) n = ~n;
    let hex = '';
    for (let i = 5; i >= 0; i--) {
        hex += ((n >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0');
    }
    const rand = new Uint8Array(14);
    crypto.getRandomValues(rand);
    let b62 = '';
    for (const v of rand) b62 += SES_ALPHABET[v % 62];
    return prefix + hex + b62;
}

function generateRotatingId() {
    return generateId('ses_', true);
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
        // 仅在存在活动聊天时读写聊天 metadata,避免主界面/无聊天时误写
        if (meta && typeof meta === 'object' && context?.chatId) {
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
    return null;
}

function getExistingSessionId() {
    const s = getSettings();
    if (s.sessionMode === 'manual') {
        return isValidToken(s.manualSessionId) ? s.manualSessionId : null;
    }
    if (s.sessionMode === 'random') {
        return isValidToken(s.randomSessionId) ? s.randomSessionId : null;
    }
    try {
        const context = getContext();
        const meta = context?.chatMetadata;
        if (meta && typeof meta === 'object' && isValidToken(meta[SESSION_VAR_KEY])) {
            return String(meta[SESSION_VAR_KEY]);
        }
    } catch {
        // fall through
    }
    return null;
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

function isOpencodeEndpoint(url) {
    if (!url) return false;
    const u = String(url).trim().replace(/\/+$/, '').toLowerCase();
    return u.includes('opencode.ai/zen/go') || u.includes('zen/go');
}

// tavern-helper(酒馆助手)额外模型解析的兜底:
// 它把端点放在 reverse_proxy,且因 custom_api.source 未设置而被降级为 openai 源,
// 服务器端 openai 分支不会合并 custom_include_headers,导致 x-opencode-session 丢失。
// 这里把请求强制改造成 custom 源,让服务器走 CUSTOM 分支合并 headers。
function applyTavernHelperFallback(generateData) {
    if (!generateData || typeof generateData !== 'object') return;
    if (!generateData.reverse_proxy) return;
    if (!isOpencodeEndpoint(generateData.reverse_proxy)) return;
    if (generateData.chat_completion_source === 'custom') return;
    if (generateData.custom_url) return;

    generateData.chat_completion_source = 'custom';
    generateData.custom_url = generateData.reverse_proxy;
}

function applyHeaders(generateData) {
    const s = getSettings();
    if (!s.enabled) return;
    applyTavernHelperFallback(generateData);
    const headers = parseHeadersYaml(generateData.custom_include_headers);
    // 额外模型走 CUSTOM 分支时,key 来自 SECRET_KEYS.CUSTOM;而 tavern-helper 的 key 在 proxy_password 里,
    // 需要显式写入 Authorization 才能通过上游认证
    if (generateData.proxy_password && !headers['Authorization']) {
        headers['Authorization'] = `Bearer ${generateData.proxy_password}`;
    }
    const sessionId = getOrCreateSessionId();
    if (sessionId) {
        headers['x-opencode-session'] = sessionId;
    }
    headers['x-opencode-request'] = generateId('msg_', false);
    headers['x-opencode-client'] = 'tui';
    trackRequestId(headers['x-opencode-request']);
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

function trackRequestId(requestId) {
    // 请求准备阶段:记录本次请求对应的目标消息(正在生成的最后一条 assistant 消息),
    // 渲染完成后把 request id 贴在它的时间旁边。
    pendingRequestId = null;
    pendingMessageId = null;
    try {
        const context = getContext();
        const chat = context?.chat;
        if (!Array.isArray(chat) || !chat.length) return;
        const last = chat[chat.length - 1];
        if (last && last.id && !last.is_user && !last.is_system) {
            pendingMessageId = last.id;
            pendingRequestId = requestId;
        }
    } catch {
        // ignore
    }
}

function attachRequestBadge(element, requestId) {
    if (!element || !requestId) return;
    const timer = element.querySelector('.mes_timer');
    if (!timer) return;
    if (timer.parentElement?.querySelector('.ocgo-request-id')) return;
    const span = document.createElement('span');
    span.className = 'ocgo-request-id';
    span.textContent = requestId;
    span.title = 'x-opencode-request';
    timer.insertAdjacentElement('afterend', span);
}

function onMessageRendered(message, element) {
    if (!pendingRequestId || !pendingMessageId) return;
    const id = message && typeof message === 'object' ? message.id : message;
    if (String(id) === String(pendingMessageId)) {
        attachRequestBadge(element, pendingRequestId);
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
                <span>启用（注入 x-opencode-* 请求头）</span>
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
            <button id="ocgo_query_id" class="menu_button">查询当前聊天 Session ID</button>
            <div id="ocgo_current_id" class="ocgo-info"></div>

            <label class="checkbox_label">
                <input id="ocgo_spoof_ua" type="checkbox" />
                <span>将 User-Agent 配置为与 opencode 客户端一致</span>
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
        const id = getExistingSessionId();
        idEl.textContent = id ? `当前会话 ID: ${id}` : '当前会话 ID: (未进入聊天,首次发送时生成)';
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

    el('ocgo_query_id').addEventListener('click', () => {
        // 主动查询/生成当前聊天的会话 ID(仅 perChat 模式依赖聊天上下文)
        const id = getOrCreateSessionId();
        renderCurrent();
        toastr.info(`当前会话 ID: ${id ?? '(未进入聊天)'}`);
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
}

function onChatLoaded() {
    // 进入聊天时:若无 ID 则生成一次并持久化,然后刷新显示
    if (getSettings().sessionMode === 'perChat') {
        getOrCreateSessionId();
    }
    renderCurrent();
}

jQuery(() => {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', TEMPLATE);
    bindSettings();
    eventSource.on(event_types.CHAT_LOADED, onChatLoaded);
    eventSource.on(event_types.MESSAGE_RENDERED, onMessageRendered);
    renderCurrent();
    console.log('[OpenCodeGoHeader] loaded.');
});