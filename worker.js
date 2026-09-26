/**
 * Cloudflare Worker: Edge TTS & OpenAI API Compatible Gateway
 * 集成特性：
 * 1. Web 界面与 IndexedDB 本地历史存储
 * 2. OpenAI /v1/audio/speech 与 /v1/models 兼容接口
 * 3. 内存 (L1) + KV/Cache API (L2) 级联凭证缓存
 * 4. Single-Flight 并发互斥锁，彻底杜绝实例冷启动与并发切片时的 Token 击穿
 */

const TOKEN_REFRESH_BEFORE_EXPIRY = 3 * 60; // 提前 3 分钟自动续期凭证

// L1 内存缓存
let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

// 实例内并发互斥单飞锁 (Single-Flight)
let pendingTokenPromise = null;

// OpenAI 声音映射表
const OPENAI_VOICE_MAP = {
    "alloy": "zh-CN-XiaoxiaoNeural",
    "echo": "zh-CN-YunxiNeural",
    "fable": "en-US-GuyNeural",
    "onyx": "zh-CN-YunjianNeural",
    "nova": "zh-CN-XiaoyiNeural",
    "shimmer": "zh-CN-XiaoxuanNeural"
};

// 音频格式映射表
const FORMAT_MAP = {
    "wav": "riff-24khz-16bit-mono-pcm",
    "pcm": "riff-24khz-16bit-mono-pcm",
    "riff-24khz-16bit-mono-pcm": "riff-24khz-16bit-mono-pcm",
    "mp3_48k": "audio-24khz-48kbitrate-mono-mp3",
    "mp3_96k": "audio-24khz-96kbitrate-mono-mp3",
    "mp3_160k": "audio-24khz-160kbitrate-mono-mp3",
    "audio-24khz-48kbitrate-mono-mp3": "audio-24khz-48kbitrate-mono-mp3",
    "audio-24khz-96kbitrate-mono-mp3": "audio-24khz-96kbitrate-mono-mp3",
    "audio-24khz-160kbitrate-mono-mp3": "audio-24khz-160kbitrate-mono-mp3",
    "mp3": "audio-24khz-160kbitrate-mono-mp3"
};

const HTML_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TTS</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232563eb'><path d='M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z'/><path d='M19 10v2a7 7 0 0 1-14 0v-2'/><line x1='12' y1='19' x2='12' y2='22' stroke='%232563eb' stroke-width='2.5'/></svg>">
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --bg: #0f172a;
            --surface: rgba(255, 255, 255, 0.32);
            --surface-sub: rgba(255, 255, 255, 0.22);
            --text-primary: #0f172a;
            --text-secondary: #334155;
            --border: rgba(255, 255, 255, 0.55);
            --border-focus: #2563eb;
            --shadow-sm: 0 4px 10px 0 rgba(0, 0, 0, 0.05);
            --shadow-md: 0 8px 20px -2px rgba(0, 0, 0, 0.08);
            --shadow-lg: 0 16px 36px -4px rgba(0, 0, 0, 0.12);
            --radius-sm: 8px;
            --radius-md: 10px;
            --radius-lg: 14px;
            --radius-xl: 18px;
        }
        [data-theme="dark"] {
            --primary: #3b82f6;
            --primary-hover: #60a5fa;
            --bg: #0b0f19;
            --surface: rgba(15, 23, 42, 0.48);
            --surface-sub: rgba(15, 23, 42, 0.36);
            --text-primary: #f8fafc;
            --text-secondary: #cbd5e1;
            --border: rgba(255, 255, 255, 0.18);
            --border-focus: #60a5fa;
            --shadow-sm: 0 4px 10px 0 rgba(0, 0, 0, 0.3);
            --shadow-md: 0 8px 20px -2px rgba(0, 0, 0, 0.4);
            --shadow-lg: 0 16px 36px -4px rgba(0, 0, 0, 0.6);
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        #bgOverlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            z-index: -2;
            transition: opacity 0.5s ease-in-out;
        }
        #bgMask {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: rgba(15, 23, 42, 0.08);
            z-index: -1;
        }
        [data-theme="dark"] #bgMask {
            background: rgba(11, 15, 25, 0.45);
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: var(--text-primary);
            line-height: 1.6;
            min-height: 100vh;
            transition: color 0.25s ease;
        }

        .float-theme-btn {
            position: fixed;
            top: 16px;
            right: 16px;
            z-index: 100;
            background: var(--surface);
            backdrop-filter: blur(16px) saturate(180%);
            -webkit-backdrop-filter: blur(16px) saturate(180%);
            border: 1px solid var(--border);
            color: var(--text-secondary);
            width: 38px;
            height: 38px;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: var(--shadow-sm);
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .float-theme-btn:hover {
            color: var(--primary);
            border-color: var(--primary);
            transform: scale(1.08);
            background: rgba(255, 255, 255, 0.5);
        }
        [data-theme="dark"] .float-theme-btn:hover {
            background: rgba(30, 41, 59, 0.65);
        }

        .container {
            max-width: 860px;
            margin: 0 auto;
            padding: 24px 16px 60px;
        }

        .countdown-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }
        @media (max-width: 640px) {
            .countdown-grid {
                grid-template-columns: 1fr;
            }
        }
        .countdown-card {
            background: var(--surface);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            padding: 14px 12px;
            text-align: center;
            box-shadow: var(--shadow-sm);
        }
        .countdown-label {
            font-size: 0.76rem;
            font-weight: 700;
            color: var(--text-secondary);
            margin-bottom: 4px;
        }
        .countdown-percentage {
            font-size: 1.7rem;
            font-weight: 800;
            color: var(--primary);
            font-family: "JetBrains Mono", Consolas, monospace;
            line-height: 1.15;
            text-shadow: 0 1px 2px rgba(255, 255, 255, 0.4);
        }
        [data-theme="dark"] .countdown-percentage {
            text-shadow: none;
        }
        .countdown-exact {
            font-size: 0.74rem;
            font-weight: 600;
            color: var(--text-secondary);
            margin-top: 4px;
            font-family: "JetBrains Mono", Consolas, monospace;
        }

        .main-card {
            background: var(--surface);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
            border-radius: var(--radius-xl);
            box-shadow: var(--shadow-lg);
            border: 1px solid var(--border);
            padding: 24px;
        }
        .form-group {
            margin-bottom: 18px;
        }
        .form-label {
            display: block;
            margin-bottom: 8px;
            font-weight: 700;
            font-size: 0.88rem;
            color: var(--text-primary);
        }
        .input-method-tabs {
            display: flex;
            gap: 6px;
            background: var(--surface-sub);
            padding: 4px;
            border-radius: var(--radius-lg);
            border: 1px solid var(--border);
        }
        .tab-btn {
            flex: 1;
            padding: 9px 14px;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            border-radius: var(--radius-md);
            font-size: 0.88rem;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s;
        }
        .tab-btn.active {
            background: var(--primary);
            color: #ffffff;
            box-shadow: var(--shadow-sm);
        }
        .form-textarea {
            width: 100%;
            min-height: 130px;
            padding: 12px 14px;
            border: 1.5px solid var(--border);
            border-radius: var(--radius-md);
            font-size: 0.95rem;
            font-weight: 500;
            background: var(--surface-sub);
            color: var(--text-primary);
            font-family: inherit;
            resize: vertical;
            transition: all 0.2s;
        }
        .form-textarea.ssml-editor {
            font-family: "JetBrains Mono", Consolas, "Courier New", monospace;
            font-size: 0.88rem;
            min-height: 180px;
        }
        .form-textarea:focus, .form-select:focus {
            outline: none;
            background: rgba(255, 255, 255, 0.45);
            border-color: var(--border-focus);
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
        }
        [data-theme="dark"] .form-textarea:focus, [data-theme="dark"] .form-select:focus {
            background: rgba(15, 23, 42, 0.55);
        }
        .file-drop-zone {
            border: 2px dashed var(--border);
            border-radius: var(--radius-lg);
            padding: 28px 16px;
            text-align: center;
            cursor: pointer;
            background: var(--surface-sub);
            font-weight: 600;
            transition: all 0.2s;
        }
        .file-drop-zone:hover, .file-drop-zone.dragover {
            border-color: var(--primary);
            background: rgba(37, 99, 235, 0.1);
        }
        .file-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: var(--surface-sub);
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
        }
        .file-remove-btn {
            background: #ef4444;
            color: #ffffff;
            border: none;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
        }
        .template-picker {
            display: flex;
            gap: 8px;
            align-items: center;
            margin-bottom: 8px;
        }
        .template-select {
            flex: 1;
            padding: 7px 10px;
            font-size: 0.84rem;
            font-weight: 600;
            border-radius: var(--radius-md);
            border: 1.5px solid var(--border);
            background: var(--surface-sub);
            color: var(--text-primary);
        }
        .controls-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
            gap: 14px;
            margin-bottom: 22px;
        }
        .form-select {
            width: 100%;
            padding: 9px 12px;
            border: 1.5px solid var(--border);
            border-radius: var(--radius-md);
            font-size: 0.88rem;
            font-weight: 600;
            color: var(--text-primary);
            background: var(--surface-sub);
        }
        .slider-label-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 6px;
        }
        .slider-val {
            font-size: 0.82rem;
            color: var(--primary);
            font-weight: 700;
        }
        .form-range {
            width: 100%;
            accent-color: var(--primary);
            cursor: pointer;
        }
        .btn-primary {
            width: 100%;
            background: var(--primary);
            color: #ffffff;
            border: none;
            padding: 13px;
            font-size: 0.96rem;
            font-weight: 700;
            border-radius: var(--radius-md);
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
        }
        .btn-primary:hover:not(:disabled) {
            background: var(--primary-hover);
            transform: translateY(-1px);
            box-shadow: 0 6px 16px rgba(37, 99, 235, 0.4);
        }
        .btn-primary:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .result-container {
            margin-top: 22px;
            padding: 18px;
            background: var(--surface-sub);
            border-radius: var(--radius-lg);
            border: 1px solid var(--border);
            display: none;
        }
        .audio-player {
            width: 100%;
            margin-bottom: 14px;
            display: block;
        }
        .btn-secondary {
            background: #10b981;
            color: #ffffff;
            border: none;
            padding: 9px 18px;
            border-radius: var(--radius-md);
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-weight: 700;
            font-size: 0.88rem;
        }
        .btn-secondary:hover {
            background: #059669;
        }
        .loading-container {
            padding: 6px 0;
        }
        .loading-spinner {
            width: 26px;
            height: 26px;
            border: 3px solid var(--border);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 0 auto 14px;
        }
        
        .pipeline-card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .pipeline-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--border);
            font-size: 0.84rem;
            font-weight: 700;
            color: var(--text-primary);
        }
        .pipeline-step {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 8px 10px;
            border-radius: var(--radius-sm);
            background: var(--surface-sub);
            border: 1px solid transparent;
            transition: all 0.2s;
        }
        .pipeline-step.active {
            border-color: var(--primary);
            background: rgba(37, 99, 235, 0.12);
        }
        .pipeline-step.done {
            border-color: rgba(16, 185, 129, 0.35);
        }
        .pipeline-step.fail {
            border-color: rgba(239, 68, 68, 0.4);
            background: rgba(239, 68, 68, 0.1);
        }
        .step-index {
            width: 20px;
            height: 20px;
            border-radius: 50%;
            background: var(--border);
            color: var(--text-secondary);
            font-size: 0.72rem;
            font-weight: 800;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            margin-top: 2px;
        }
        .pipeline-step.active .step-index {
            background: var(--primary);
            color: #fff;
        }
        .pipeline-step.done .step-index {
            background: #10b981;
            color: #fff;
        }
        .pipeline-step.fail .step-index {
            background: #ef4444;
            color: #fff;
        }
        .step-body {
            flex: 1;
            min-width: 0;
        }
        .step-title-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2px;
        }
        .step-name {
            font-size: 0.84rem;
            font-weight: 700;
            color: var(--text-primary);
        }
        .step-badge {
            font-size: 0.7rem;
            padding: 1px 7px;
            border-radius: 999px;
            background: var(--border);
            color: var(--text-secondary);
            font-weight: 700;
        }
        .pipeline-step.active .step-badge {
            background: rgba(37, 99, 235, 0.2);
            color: var(--primary);
        }
        .pipeline-step.done .step-badge {
            background: rgba(16, 185, 129, 0.2);
            color: #10b981;
        }
        .pipeline-step.fail .step-badge {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
        }
        .step-desc {
            font-size: 0.75rem;
            color: var(--text-secondary);
            line-height: 1.35;
        }

        .error-card {
            border: 1px solid #fecaca;
            background: rgba(254, 242, 242, 0.9);
            border-radius: var(--radius-md);
            padding: 14px;
            margin-top: 10px;
        }
        [data-theme="dark"] .error-card {
            background: rgba(69, 26, 26, 0.9);
            border-color: #7f1d1d;
        }
        .error-header {
            display: flex;
            align-items: center;
            gap: 8px;
            color: #dc2626;
            font-weight: 700;
            font-size: 0.92rem;
            margin-bottom: 6px;
        }
        [data-theme="dark"] .error-header {
            color: #f87171;
        }
        .error-summary {
            font-size: 0.85rem;
            color: var(--text-primary);
            margin-bottom: 10px;
            line-height: 1.5;
        }
        .debug-panel {
            background: #0f172a;
            color: #38bdf8;
            border-radius: var(--radius-md);
            padding: 10px;
            font-family: "JetBrains Mono", Consolas, monospace;
            font-size: 0.76rem;
            overflow-x: auto;
            max-height: 180px;
            white-space: pre-wrap;
            word-break: break-all;
            margin-bottom: 10px;
        }
        .debug-actions {
            display: flex;
            gap: 8px;
        }
        .btn-debug {
            background: var(--surface);
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 5px 10px;
            font-size: 0.76rem;
            border-radius: var(--radius-sm);
            cursor: pointer;
            font-weight: 600;
        }
        .btn-debug:hover {
            border-color: var(--primary);
            color: var(--primary);
        }

        .history-section {
            margin-top: 24px;
            background: var(--surface);
            backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%);
            border-radius: var(--radius-lg);
            border: 1px solid var(--border);
            padding: 18px;
        }
        .history-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
        }
        .history-clear-btn {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-secondary);
            padding: 3px 8px;
            font-size: 0.76rem;
            border-radius: var(--radius-sm);
            cursor: pointer;
        }
        .history-clear-btn:hover {
            color: #dc2626;
            border-color: #dc2626;
        }
        .history-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            max-height: 260px;
            overflow-y: auto;
        }
        .history-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 9px 12px;
            background: var(--surface-sub);
            border-radius: var(--radius-md);
            border: 1px solid var(--border);
            gap: 10px;
        }
        .history-text {
            font-size: 0.84rem;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--text-primary);
        }
        .history-meta {
            font-size: 0.74rem;
            color: var(--text-secondary);
            margin-top: 2px;
        }
        .history-actions {
            display: flex;
            gap: 6px;
        }
        .history-btn {
            background: var(--surface);
            border: 1px solid var(--border);
            padding: 4px 8px;
            border-radius: var(--radius-sm);
            font-size: 0.75rem;
            font-weight: 600;
            cursor: pointer;
            color: var(--text-primary);
            text-decoration: none;
        }
        .history-btn:hover {
            color: var(--primary);
            border-color: var(--primary);
        }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div id="bgOverlay"></div>
    <div id="bgMask"></div>

    <button class="float-theme-btn" id="themeToggle" aria-label="切换主题">
        <svg id="themeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
        </svg>
    </button>

    <main class="container">
        <div class="countdown-grid">
            <div class="countdown-card">
                <div class="countdown-label">今日剩余 (至凌晨)</div>
                <div class="countdown-percentage" id="dayPercent">0.00%</div>
                <div class="countdown-exact" id="dayExact">剩余 00:00:00</div>
            </div>
            <div class="countdown-card">
                <div class="countdown-label">本年剩余 (至元旦)</div>
                <div class="countdown-percentage" id="yearPercent">0.00%</div>
                <div class="countdown-exact" id="yearExact">剩余 0天 00:00:00</div>
            </div>
            <div class="countdown-card">
                <div class="countdown-label">28年夏季高考 (至6月7日)</div>
                <div class="countdown-percentage" id="gaokaoPercent">0.00%</div>
                <div class="countdown-exact" id="gaokaoExact">剩余 0天 00:00:00</div>
            </div>
        </div>

        <div class="main-card">
            <form id="ttsForm">
                <div class="form-group">
                    <label class="form-label">输入模式</label>
                    <div class="input-method-tabs">
                        <button type="button" class="tab-btn active" id="textTab">手动输入</button>
                        <button type="button" class="tab-btn" id="fileTab">上传 TXT</button>
                        <button type="button" class="tab-btn" id="ssmlTab">&lt; &gt; SSML 模式</button>
                    </div>
                </div>

                <div class="form-group" id="textArea">
                    <label class="form-label" for="textInput">文本内容</label>
                    <textarea class="form-textarea" id="textInput" placeholder="输入要转换的文本，支持使用 [pause:500ms] 停顿标记..."></textarea>
                </div>

                <div class="form-group" id="fileArea" style="display: none;">
                    <label class="form-label">上传 TXT 文本文档</label>
                    <div class="file-drop-zone" id="dropZone">
                        <p>点击或拖拽 TXT 文件到此处（最大 500KB）</p>
                        <input type="file" id="fileInput" accept=".txt,text/plain" style="display: none;">
                    </div>
                    <div class="file-info" id="fileInfo" style="display: none;">
                        <span id="fileName"></span>
                        <button type="button" class="file-remove-btn" id="fileRemoveBtn">✕ 移除</button>
                    </div>
                </div>

                <div class="form-group" id="ssmlArea" style="display: none;">
                    <div class="template-picker">
                        <label class="form-label" style="margin:0; min-width:80px;">预设模板:</label>
                        <select class="template-select" id="templateSelect">
                            <option value="">快速载入 SSML 剧本模板...</option>
                            <option value="dialog">双人跨国交替对话（男女声混播）</option>
                            <option value="documentary">纪录片深沉男声旁白（低沉慢速）</option>
                            <option value="multilang">八国语言国际联调测试</option>
                        </select>
                    </div>
                    <textarea class="form-textarea ssml-editor" id="ssmlInput" placeholder="在此输入完整 SSML 代码..."></textarea>
                </div>

                <div class="controls-grid">
                    <div class="form-group">
                        <label class="form-label" for="voiceSelect">发音人 (90+ 音色)</label>
                        <select class="form-select" id="voiceSelect">
                            <optgroup label="中文 (普通话/方言)">
                                <option value="zh-CN-YunxiNeural" selected>云希 (男声·清朗)</option>
                                <option value="zh-CN-XiaoxiaoNeural">晓晓 (女声·温柔)</option>
                                <option value="zh-CN-YunyangNeural">云扬 (男声·阳光)</option>
                                <option value="zh-CN-XiaoyiNeural">晓伊 (女声·甜美)</option>
                                <option value="zh-CN-YunjianNeural">云健 (男声·稳重)</option>
                                <option value="zh-CN-XiaochenNeural">晓辰 (女声·知性)</option>
                                <option value="zh-CN-XiaohanNeural">晓涵 (女声·优雅)</option>
                                <option value="zh-CN-XiaomengNeural">晓梦 (女声·梦幻)</option>
                                <option value="zh-CN-XiaomoNeural">晓墨 (女声·文艺)</option>
                                <option value="zh-CN-XiaoqiuNeural">晓秋 (女声·成熟)</option>
                                <option value="zh-CN-XiaoruiNeural">晓睿 (女声·智慧)</option>
                                <option value="zh-CN-XiaoshuangNeural">晓双 (女声·活泼)</option>
                                <option value="zh-CN-XiaoxuanNeural">晓萱 (女声·清新)</option>
                                <option value="zh-CN-XiaoyanNeural">晓颜 (女声·柔美)</option>
                                <option value="zh-CN-XiaoyouNeural">晓悠 (女声·悠扬)</option>
                                <option value="zh-CN-XiaozhenNeural">晓甄 (女声·端庄)</option>
                                <option value="zh-CN-YunfengNeural">云枫 (男声·磁性)</option>
                                <option value="zh-CN-YunhaoNeural">云皓 (男声·豪迈)</option>
                                <option value="zh-CN-YunxiaNeural">云夏 (男声·热情)</option>
                                <option value="zh-CN-YunyeNeural">云野 (男声·野性)</option>
                                <option value="zh-CN-YunzeNeural">云泽 (男声·深沉)</option>
                            </optgroup>
                            <optgroup label="英语 (English)">
                                <option value="en-US-JennyNeural">Jenny (女声, US)</option>
                                <option value="en-US-GuyNeural">Guy (男声, US)</option>
                                <option value="en-US-AriaNeural">Aria (女声, US)</option>
                                <option value="en-US-DavisNeural">Davis (男声, US)</option>
                                <option value="en-GB-RyanNeural">Ryan (男声, UK)</option>
                                <option value="en-AU-NatashaNeural">Natasha (女声, AU)</option>
                            </optgroup>
                            <optgroup label="日语 (日本語)">
                                <option value="ja-JP-NanamiNeural">七海 Nanami (女声)</option>
                                <option value="ja-JP-KeitaNeural">圭太 Keita (男声)</option>
                                <option value="ja-JP-AoiNeural">葵 Aoi (女声)</option>
                                <option value="ja-JP-DaichiNeural">大地 Daichi (男声)</option>
                            </optgroup>
                            <optgroup label="韩语 (한국어)">
                                <option value="ko-KR-SunHiNeural">SunHi (女声)</option>
                                <option value="ko-KR-InJoonNeural">InJoon (男声)</option>
                            </optgroup>
                            <optgroup label="欧洲多国语言">
                                <option value="fr-FR-DeniseNeural">Denise (法语女声)</option>
                                <option value="de-DE-KatjaNeural">Katja (德语女声)</option>
                                <option value="es-ES-ElviraNeural">Elvira (西语女声)</option>
                                <option value="ru-RU-SvetlanaNeural">Svetlana (俄语女声)</option>
                            </optgroup>
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="formatSelect">音频品质</label>
                        <select class="form-select" id="formatSelect">
                            <option value="audio-24khz-160kbitrate-mono-mp3" selected>MP3 高保真 (160 kbps)</option>
                            <option value="audio-24khz-96kbitrate-mono-mp3">MP3 标准 (96 kbps)</option>
                            <option value="audio-24khz-48kbitrate-mono-mp3">MP3 省流 (48 kbps)</option>
                            <option value="riff-24khz-16bit-mono-pcm">WAV 无损音频 (24kHz 16Bit)</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <div class="slider-label-row">
                            <label class="form-label" style="margin:0;">语速</label>
                            <span class="slider-val" id="speedVal">1.00x</span>
                        </div>
                        <input type="range" class="form-range" id="speedInput" min="0.5" max="2.0" step="0.05" value="1.0">
                    </div>

                    <div class="form-group">
                        <div class="slider-label-row">
                            <label class="form-label" style="margin:0;">音调</label>
                            <span class="slider-val" id="pitchVal">0Hz</span>
                        </div>
                        <input type="range" class="form-range" id="pitchInput" min="-50" max="50" step="1" value="0">
                    </div>
                </div>

                <button type="submit" class="btn-primary" id="generateBtn">
                    <span>🎙️</span>
                    <span>立即生成语音</span>
                </button>
            </form>

            <div id="result" class="result-container">
                <div id="loading" class="loading-container" style="display: none;">
                    <div class="loading-spinner"></div>
                    <div class="pipeline-card">
                        <div class="pipeline-header">
                            <span>系统执行链路状态</span>
                            <span id="pipelineOverall" style="font-size:0.75rem; color:var(--text-secondary);">正在处理...</span>
                        </div>
                        
                        <div class="pipeline-step" id="pipeStep1">
                            <div class="step-index">1</div>
                            <div class="step-body">
                                <div class="step-title-row">
                                    <span class="step-name">入参校验与语法解析</span>
                                    <span class="step-badge" id="badgeStep1">等待中</span>
                                </div>
                                <div class="step-desc">解析文本载荷，验证 SSML 标签层级合法性并打包标准请求结构体。</div>
                            </div>
                        </div>

                        <div class="pipeline-step" id="pipeStep2">
                            <div class="step-index">2</div>
                            <div class="step-body">
                                <div class="step-title-row">
                                    <span class="step-name">安全网关握手与凭证鉴权</span>
                                    <span class="step-badge" id="badgeStep2">等待中</span>
                                </div>
                                <div class="step-desc">计算 HMAC-SHA256 签名并与微软 Translator 鉴权端点换取短期通信凭证。</div>
                            </div>
                        </div>

                        <div class="pipeline-step" id="pipeStep3">
                            <div class="step-index">3</div>
                            <div class="step-body">
                                <div class="step-title-row">
                                    <span class="step-name">边缘神经语音合成与流传输</span>
                                    <span class="step-badge" id="badgeStep3">等待中</span>
                                </div>
                                <div class="step-desc">向边缘节点推送合成配置，实时校验发音人模型并接收分块二进制流。</div>
                            </div>
                        </div>

                        <div class="pipeline-step" id="pipeStep4">
                            <div class="step-index">4</div>
                            <div class="step-body">
                                <div class="step-title-row">
                                    <span class="step-name">二进制流挂载与本地存储</span>
                                    <span class="step-badge" id="badgeStep4">等待中</span>
                                </div>
                                <div class="step-desc">完成 Blob 音频流拼接，写入浏览器本地 IndexedDB 缓存并初始化播放器。</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="success" style="display: none;">
                    <div style="font-size:0.85rem; font-weight:700; color:#10b981; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                        <span>✓</span> 音频生成完毕，已就绪
                    </div>
                    <audio id="audioPlayer" class="audio-player" controls preload="auto"></audio>
                    <a id="downloadBtn" class="btn-secondary" download="speech.mp3">
                        <span>📥</span>
                        <span>下载音频文件</span>
                    </a>
                </div>

                <div id="errorCard" class="error-card" style="display: none;">
                    <div class="error-header">
                        <span>⚠️</span>
                        <span id="errorTitle">请求异常</span>
                    </div>
                    <div class="error-summary" id="errorSummary"></div>
                    <div class="debug-panel" id="debugJson"></div>
                    <div class="debug-actions">
                        <button type="button" class="btn-debug" id="copyReportBtn">📋 复制排错报告</button>
                    </div>
                </div>
            </div>

            <div class="history-section">
                <div class="history-header">
                    <h3 style="font-size:0.95rem; font-weight:700;">本地生成历史 (离线缓存)</h3>
                    <button class="history-clear-btn" id="clearHistoryBtn">清空历史</button>
                </div>
                <div class="history-list" id="historyList">
                    <div style="font-size:0.85rem; color:var(--text-secondary); text-align:center; padding:12px;">暂无历史记录</div>
                </div>
            </div>
        </div>
    </main>

    <script>
        const bg = document.getElementById('bgOverlay');
        if (bg) {
            bg.style.backgroundImage = "url('/api/wallpaper?t=" + Date.now() + "')";
        }

        const themeToggle = document.getElementById('themeToggle');
        const themeIcon = document.getElementById('themeIcon');
        function applyTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('tts_theme', theme);
            if (theme === 'dark') {
                themeIcon.innerHTML = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
            } else {
                themeIcon.innerHTML = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
            }
        }
        themeToggle.addEventListener('click', function() {
            const current = document.documentElement.getAttribute('data-theme') || 'light';
            applyTheme(current === 'dark' ? 'light' : 'dark');
        });
        const savedTheme = localStorage.getItem('tts_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        applyTheme(savedTheme);

        function padZero(num) {
            return num < 10 ? '0' + num : String(num);
        }

        function updateCountdowns() {
            const now = new Date();
            const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
            const bjTime = new Date(utcTime + (8 * 3600000));
            const nowMs = bjTime.getTime();

            const cYear = bjTime.getFullYear();
            const cMonth = bjTime.getMonth();
            const cDate = bjTime.getDate();

            const todayStart = new Date(cYear, cMonth, cDate, 0, 0, 0).getTime();
            const todayEnd = todayStart + 86400000;
            const dayRemMs = Math.max(0, todayEnd - nowMs);
            const dayPercent = ((dayRemMs / 86400000) * 100).toFixed(2);

            const dayHrs = padZero(Math.floor(dayRemMs / 3600000));
            const dayMins = padZero(Math.floor((dayRemMs % 3600000) / 60000));
            const daySecs = padZero(Math.floor((dayRemMs % 60000) / 1000));

            document.getElementById('dayPercent').textContent = dayPercent + '%';
            document.getElementById('dayExact').textContent = '剩余 ' + dayHrs + ':' + dayMins + ':' + daySecs;

            const yearStart = new Date(cYear, 0, 1, 0, 0, 0).getTime();
            const nextYearStart = new Date(cYear + 1, 0, 1, 0, 0, 0).getTime();
            const yearTotalMs = nextYearStart - yearStart;
            const yearRemMs = Math.max(0, nextYearStart - nowMs);
            const yearPercent = ((yearRemMs / yearTotalMs) * 100).toFixed(2);

            const yearDays = Math.floor(yearRemMs / 86400000);
            const yearHrs = padZero(Math.floor((yearRemMs % 86400000) / 3600000));
            const yearMins = padZero(Math.floor((yearRemMs % 3600000) / 60000));
            const yearSecs = padZero(Math.floor((yearRemMs % 60000) / 1000));

            document.getElementById('yearPercent').textContent = yearPercent + '%';
            document.getElementById('yearExact').textContent = '剩余 ' + yearDays + '天 ' + yearHrs + ':' + yearMins + ':' + yearSecs;

            const gaokaoTarget = new Date(2028, 5, 7, 9, 0, 0).getTime();
            const gaokaoCycleStart = new Date(2025, 8, 1, 0, 0, 0).getTime();
            const gaokaoTotalMs = gaokaoTarget - gaokaoCycleStart;
            const gaokaoRemMs = Math.max(0, gaokaoTarget - nowMs);
            const gaokaoPercent = ((gaokaoRemMs / gaokaoTotalMs) * 100).toFixed(2);

            const gkDays = Math.floor(gaokaoRemMs / 86400000);
            const gkHrs = padZero(Math.floor((gaokaoRemMs % 86400000) / 3600000));
            const gkMins = padZero(Math.floor((gaokaoRemMs % 3600000) / 60000));
            const gkSecs = padZero(Math.floor((gaokaoRemMs % 60000) / 1000));

            document.getElementById('gaokaoPercent').textContent = gaokaoPercent + '%';
            document.getElementById('gaokaoExact').textContent = '剩余 ' + gkDays + '天 ' + gkHrs + ':' + gkMins + ':' + gkSecs;
        }

        updateCountdowns();
        setInterval(updateCountdowns, 1000);

        let activeTab = 'text';
        let fileContent = '';
        const textTab = document.getElementById('textTab');
        const fileTab = document.getElementById('fileTab');
        const ssmlTab = document.getElementById('ssmlTab');
        const textArea = document.getElementById('textArea');
        const fileArea = document.getElementById('fileArea');
        const ssmlArea = document.getElementById('ssmlArea');

        function switchTab(tab) {
            activeTab = tab;
            [textTab, fileTab, ssmlTab].forEach(function(t) { t.classList.remove('active'); });
            [textArea, fileArea, ssmlArea].forEach(function(a) { a.style.display = 'none'; });
            if (tab === 'text') { textTab.classList.add('active'); textArea.style.display = 'block'; }
            if (tab === 'file') { fileTab.classList.add('active'); fileArea.style.display = 'block'; }
            if (tab === 'ssml') { ssmlTab.classList.add('active'); ssmlArea.style.display = 'block'; }
        }
        textTab.onclick = function() { switchTab('text'); };
        fileTab.onclick = function() { switchTab('file'); };
        ssmlTab.onclick = function() { switchTab('ssml'); };

        const dropZone = document.getElementById('dropZone');
        const fileInput = document.getElementById('fileInput');
        const fileInfo = document.getElementById('fileInfo');
        const fileName = document.getElementById('fileName');
        const fileRemoveBtn = document.getElementById('fileRemoveBtn');

        dropZone.onclick = function() { fileInput.click(); };
        fileInput.onchange = function(e) { handleFile(e.target.files[0]); };
        dropZone.ondragover = function(e) { e.preventDefault(); dropZone.classList.add('dragover'); };
        dropZone.ondragleave = function() { dropZone.classList.remove('dragover'); };
        dropZone.ondrop = function(e) { e.preventDefault(); dropZone.classList.remove('dragover'); handleFile(e.dataTransfer.files[0]); };

        function handleFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function(e) {
                fileContent = e.target.result;
                fileName.textContent = file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
                dropZone.style.display = 'none';
                fileInfo.style.display = 'flex';
            };
            reader.readAsText(file);
        }
        fileRemoveBtn.onclick = function() {
            fileContent = '';
            fileInput.value = '';
            fileInfo.style.display = 'none';
            dropZone.style.display = 'block';
        };

        const speedInput = document.getElementById('speedInput');
        const pitchInput = document.getElementById('pitchInput');
        speedInput.oninput = function() { document.getElementById('speedVal').textContent = parseFloat(speedInput.value).toFixed(2) + 'x'; };
        pitchInput.oninput = function() { document.getElementById('pitchVal').textContent = (pitchInput.value >= 0 ? '+' : '') + pitchInput.value + 'Hz'; };

        const SSML_TEMPLATES = {
            dialog: '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\\n  <voice name="zh-CN-YunxiNeural">\\n    <prosody rate="-5%" pitch="-5Hz">大家好，今天我们进行跨语种系统联调。</prosody>\\n    <break time="500ms" />\\n  </voice>\\n  <voice name="en-US-JennyNeural">\\n    <prosody rate="+5%">All systems are running properly and ready for deployment.</prosody>\\n    <break time="500ms" />\\n  </voice>\\n  <voice name="zh-CN-XiaoxiaoNeural">\\n    <prosody rate="+10%" pitch="+10Hz">收到，双角色对话测试顺利完成！</prosody>\\n  </voice>\\n</speak>',
            documentary: '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">\\n  <voice name="zh-CN-YunjianNeural">\\n    <prosody rate="-15%" pitch="-15Hz">\\n      深邃的夜幕之下，大自然的交响曲正在无声地流淌。时间在这一刻缓缓定格。\\n    </prosody>\\n  </voice>\\n</speak>',
            multilang: '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\\n  <voice name="zh-CN-YunxiNeural">\\n    <prosody rate="-5%">欢迎收听全球多语言语音合成系统联调测试。</prosody>\\n    <break time="500ms" />\\n  </voice>\\n  <voice name="en-US-JennyNeural">\\n    <prosody rate="+5%">Welcome to the global voice synthesis showcase.</prosody>\\n    <break time="500ms" />\\n  </voice>\\n  <voice name="ja-JP-NanamiNeural">\\n    <prosody pitch="+5Hz">世界中の皆様、こんにちは。音声合成テストが進行中です。</prosody>\\n  </voice>\\n</speak>'
        };
        document.getElementById('templateSelect').onchange = function() {
            if (this.value && SSML_TEMPLATES[this.value]) {
                document.getElementById('ssmlInput').value = SSML_TEMPLATES[this.value];
            }
        };

        const DB_NAME = 'TTS_DB_Standalone';
        const STORE_NAME = 'audio_history';
        let db;
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function(e) {
            const d = e.target.result;
            if (!d.objectStoreNames.contains(STORE_NAME)) {
                d.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = function(e) { db = e.target.result; loadHistory(); };

        function saveHistoryItem(textPreview, voice, format, blob) {
            if (!db) return;
            const tx = db.transaction([STORE_NAME], 'readwrite');
            tx.objectStore(STORE_NAME).add({
                text: textPreview.slice(0, 40) + (textPreview.length > 40 ? '...' : ''),
                voice: voice,
                format: format.includes('pcm') ? 'WAV' : 'MP3',
                blob: blob,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            });
            tx.oncomplete = function() { loadHistory(); };
        }

        function loadHistory() {
            if (!db) return;
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = function() {
                const list = document.getElementById('historyList');
                const items = req.result.reverse().slice(0, 20);
                if (!items.length) {
                    list.innerHTML = '<div style="font-size:0.85rem; color:var(--text-secondary); text-align:center; padding:12px;">暂无历史记录</div>';
                    return;
                }
                list.innerHTML = '';
                items.forEach(function(item) {
                    const blobUrl = URL.createObjectURL(item.blob);
                    const ext = item.format === 'WAV' ? 'wav' : 'mp3';
                    const el = document.createElement('div');
                    el.className = 'history-item';
                    el.innerHTML = '<div style="flex:1; min-width:0;"><div class="history-text">' + item.text + '</div><div class="history-meta">' + item.voice + ' · ' + item.format + ' · ' + item.time + '</div></div><div class="history-actions"><button class="history-btn play-btn" data-url="' + blobUrl + '">载入</button><a class="history-btn" href="' + blobUrl + '" download="tts_' + Date.now() + '.' + ext + '">下载</a></div>';
                    list.appendChild(el);
                });
                document.querySelectorAll('.play-btn').forEach(function(btn) {
                    btn.onclick = function() {
                        const p = document.getElementById('audioPlayer');
                        p.src = btn.getAttribute('data-url');
                        document.getElementById('result').style.display = 'block';
                        document.getElementById('loading').style.display = 'none';
                        document.getElementById('errorCard').style.display = 'none';
                        document.getElementById('success').style.display = 'block';
                    };
                });
            };
        }
        document.getElementById('clearHistoryBtn').onclick = function() {
            if (!db) return;
            const tx = db.transaction([STORE_NAME], 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            tx.oncomplete = function() { loadHistory(); };
        };

        function setPipelineStep(stepNum, status, badgeText) {
            const stepEl = document.getElementById('pipeStep' + stepNum);
            const targetBadge = document.getElementById('badgeStep' + stepNum);
            if (!stepEl || !targetBadge) return;
            stepEl.className = 'pipeline-step ' + status;
            targetBadge.textContent = badgeText;
        }

        let lastErrorReport = null;
        document.getElementById('copyReportBtn').onclick = function() {
            if (!lastErrorReport) return;
            navigator.clipboard.writeText(JSON.stringify(lastErrorReport, null, 2)).then(function() {
                alert('排错报告已复制到剪贴板！');
            });
        };

        document.getElementById('ttsForm').onsubmit = async function(e) {
            e.preventDefault();
            let inputText = '';
            if (activeTab === 'text') inputText = document.getElementById('textInput').value;
            if (activeTab === 'file') inputText = fileContent;
            if (activeTab === 'ssml') inputText = document.getElementById('ssmlInput').value;

            if (!inputText.trim()) {
                alert('请输入或上传文本内容');
                return;
            }

            const generateBtn = document.getElementById('generateBtn');
            const result = document.getElementById('result');
            const loading = document.getElementById('loading');
            const success = document.getElementById('success');
            const errorCard = document.getElementById('errorCard');
            const player = document.getElementById('audioPlayer');
            const downloadBtn = document.getElementById('downloadBtn');

            result.style.display = 'block';
            loading.style.display = 'block';
            success.style.display = 'none';
            errorCard.style.display = 'none';
            generateBtn.disabled = true;

            setPipelineStep(1, 'active', '解析中...');
            setPipelineStep(2, '', '等待中');
            setPipelineStep(3, '', '等待中');
            setPipelineStep(4, '', '等待中');
            document.getElementById('pipelineOverall').textContent = '阶段 1/4';

            const voice = document.getElementById('voiceSelect').value;
            const format = document.getElementById('formatSelect').value;
            const speed = document.getElementById('speedInput').value;
            const pitch = document.getElementById('pitchInput').value;

            setPipelineStep(1, 'done', '已就绪');
            setPipelineStep(2, 'active', '握手中...');
            document.getElementById('pipelineOverall').textContent = '阶段 2/4';

            try {
                const res = await fetch('/v1/audio/speech', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        input: inputText,
                        voice: voice,
                        outputFormat: format,
                        speed: parseFloat(speed),
                        pitch: pitch + 'Hz'
                    })
                });

                if (!res.ok) {
                    let errObj = {};
                    try {
                        errObj = await res.json();
                    } catch (ex) {
                        errObj = { error: { message: await res.text(), status: res.status } };
                    }
                    throw errObj;
                }

                setPipelineStep(2, 'done', '鉴权通过');
                setPipelineStep(3, 'done', '传输完毕');
                setPipelineStep(4, 'active', '正在装载...');
                document.getElementById('pipelineOverall').textContent = '阶段 4/4';

                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const isWav = format.includes('pcm');

                player.src = url;
                player.currentTime = 0;
                downloadBtn.href = url;
                downloadBtn.download = 'speech_' + Date.now() + '.' + (isWav ? 'wav' : 'mp3');

                setPipelineStep(4, 'done', '完成');

                setTimeout(function() {
                    loading.style.display = 'none';
                    success.style.display = 'block';
                }, 350);

                saveHistoryItem(inputText, voice, format, blob);
            } catch (err) {
                loading.style.display = 'none';
                errorCard.style.display = 'block';

                const errPayload = err.error || err;
                lastErrorReport = {
                    timestamp: new Date().toISOString(),
                    step: errPayload.step || 'UNKNOWN_STAGE',
                    http_status: errPayload.status || 500,
                    error_message: errPayload.message || String(err),
                    server_details: errPayload.details || null,
                    voice: voice,
                    outputFormat: format,
                    payload_snippet: inputText.slice(0, 300)
                };

                if (errPayload.step === 'AUTH_TOKEN') {
                    setPipelineStep(2, 'fail', '鉴权中断');
                } else if (errPayload.step === 'EDGE_SYNTH') {
                    setPipelineStep(2, 'done', '鉴权通过');
                    setPipelineStep(3, 'fail', '语法拒绝 (400)');
                }

                document.getElementById('errorTitle').textContent = '合成中断 (' + (errPayload.step || '错误') + ')';
                document.getElementById('errorSummary').textContent = errPayload.message || '请求发生异常';
                document.getElementById('debugJson').textContent = JSON.stringify(lastErrorReport, null, 2);
            } finally {
                generateBtn.disabled = false;
            }
        };
    </script>
</body>
</html>
`;

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    }
};

async function handleRequest(request, env, ctx) {
    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }

    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    if (path === "/" || path === "/index.html") {
        return new Response(HTML_PAGE, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                ...makeCORSHeaders()
            }
        });
    }

    if (path === "/api/wallpaper") {
        try {
            const userAgent = request.headers.get("user-agent") || "";
            const isMobile = /mobile|android|iphone|ipad|phone/i.test(userAgent);
            
            const targetUrl = isMobile 
                ? "https://t.alcy.cc/mp" 
                : "https://t.alcy.cc/pc";

            const imgRes = await fetch(targetUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": "https://www.pixiv.net/"
                },
                redirect: "follow"
            });

            if (!imgRes.ok) throw new Error("获取壁纸流失败");

            return new Response(imgRes.body, {
                headers: {
                    "Content-Type": imgRes.headers.get("Content-Type") || "image/jpeg",
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    ...makeCORSHeaders()
                }
            });
        } catch (err) {
            return Response.redirect("https://picsum.photos/1920/1080", 302);
        }
    }

    if (path === "/v1/models") {
        return new Response(JSON.stringify({
            object: "list",
            data: [
                { id: "tts-1", object: "model", owned_by: "edge-tts" },
                { id: "tts-1-hd", object: "model", owned_by: "edge-tts" },
                { id: "zh-CN-YunxiNeural", object: "model", owned_by: "microsoft" },
                { id: "zh-CN-XiaoxiaoNeural", object: "model", owned_by: "microsoft" },
                { id: "en-US-JennyNeural", object: "model", owned_by: "microsoft" }
            ]
        }), {
            headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
        });
    }

    if (path === "/v1/audio/speech") {
        try {
            const requestBody = await request.json();

            const textContent = requestBody.input || requestBody.ssml || requestBody.text || "";
            const rawVoice = requestBody.voice || "zh-CN-YunxiNeural";
            const voice = OPENAI_VOICE_MAP[rawVoice.toLowerCase()] || rawVoice;

            const rawFormat = (requestBody.response_format || requestBody.outputFormat || requestBody.format || "mp3").toLowerCase();
            const outputFormat = FORMAT_MAP[rawFormat] || "audio-24khz-160kbitrate-mono-mp3";

            const speedVal = parseFloat(requestBody.speed || 1.0);
            let rate = parseInt(String((speedVal - 1.0) * 100));
            let numPitch = parseInt(String(requestBody.pitch || 0));

            return await getVoice(
                textContent,
                voice,
                rate >= 0 ? `+${rate}%` : `${rate}%`,
                numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
                "+0%",
                requestBody.style || "general",
                outputFormat,
                env,
                ctx
            );

        } catch (error) {
            console.error("TTS 错误:", error);
            const status = error.status || 500;
            return new Response(JSON.stringify({
                error: {
                    step: error.step || "SERVER_INTERNAL",
                    message: error.message || "服务内部异常",
                    details: error.details || null,
                    status: status,
                    code: "edge_tts_error"
                }
            }), {
                status: status,
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        }
    }

    return new Response("Not Found", { status: 404 });
}

async function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": "*"
        }
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function optimizedTextSplit(text, maxChunkSize = 1500) {
    const chunks = [];
    const sentences = text.split(/[。！？\n]/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;
        if (trimmed.length > maxChunkSize) {
            if (currentChunk) { chunks.push(currentChunk.trim()); currentChunk = ''; }
            for (let i = 0; i < trimmed.length; i += maxChunkSize) {
                chunks.push(trimmed.slice(i, i + maxChunkSize));
            }
        } else if ((currentChunk + trimmed).length > maxChunkSize) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = trimmed;
        } else {
            currentChunk += (currentChunk ? '。' : '') + trimmed;
        }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());
    return chunks.filter(c => c.length > 0);
}

async function processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, env, ctx) {
    const audioChunks = [];
    for (let i = 0; i < chunks.length; i += 3) {
        const batch = chunks.slice(i, i + 3);
        const batchResults = await Promise.all(
            batch.map((c, idx) => delay(idx * 150).then(() => getAudioChunk(c, voiceName, rate, pitch, volume, style, outputFormat, 3, env, ctx)))
        );
        audioChunks.push(...batchResults);
        if (i + 3 < chunks.length) await delay(600);
    }
    return audioChunks;
}

async function getVoice(text = "", voiceName = "zh-CN-YunxiNeural", rate = '+0%', pitch = '+0Hz', volume = '+0%', style = "general", outputFormat = "audio-24khz-160kbitrate-mono-mp3", env, ctx) {
    const cleanText = (text || "").trim();
    if (!cleanText) {
        const err = new Error("输入文本为空，无法生成音频");
        err.step = "PARAM_VALIDATION";
        err.status = 400;
        throw err;
    }

    const isWav = outputFormat.includes("pcm");
    const mimeType = isWav ? "audio/wav" : "audio/mpeg";

    if (cleanText.startsWith('<speak') || cleanText.length <= 1500) {
        const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat, 3, env, ctx);
        return new Response(audioBlob, {
            headers: { "Content-Type": mimeType, ...makeCORSHeaders() }
        });
    }

    const chunks = optimizedTextSplit(cleanText, 1500);
    if (chunks.length > 40) {
        const err = new Error("文本过长，切片数量超过最大限制 (40 段)");
        err.step = "TEXT_CHUNK_LIMIT";
        err.status = 413;
        throw err;
    }

    const audioChunks = await processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, env, ctx);
    const concatenatedAudio = new Blob(audioChunks, { type: mimeType });

    return new Response(concatenatedAudio, {
        headers: { "Content-Type": mimeType, ...makeCORSHeaders() }
    });
}

async function getAudioChunk(text, voiceName, rate, pitch, volume, style, outputFormat, maxRetries = 3, env, ctx) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint(env, ctx);
            const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

            let slien = 0;
            const m = text.match(/\[(\d+)\]\s*?$/);
            if (m && m.length === 2) {
                slien = parseInt(m[1]);
                text = text.replace(m[0], '');
            }

            const requestSsml = getSsml(text, voiceName, rate, pitch, volume, style, slien);

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": endpoint.t,
                    "Content-Type": "application/ssml+xml",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: requestSsml
            });

            if (!response.ok) {
                const errorBody = await response.text();
                if (attempt < maxRetries && response.status >= 500) {
                    await delay(500 * (attempt + 1));
                    continue;
                }
                const err = new Error(`Edge TTS 合成请求被拒绝 (HTTP ${response.status})`);
                err.step = "EDGE_SYNTH";
                err.status = response.status;
                err.details = errorBody;
                throw err;
            }

            return await response.blob();
        } catch (e) {
            if (attempt === maxRetries || e.step === "EDGE_SYNTH") throw e;
            await delay(500 * (attempt + 1));
        }
    }
}

function escapeXmlText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function getSsml(text, voiceName, rate, pitch, volume, style, slien = 0) {
    if (text.trim().startsWith('<speak')) {
        return text.trim();
    }
    const escaped = escapeXmlText(text);
    const breakTag = slien > 0 ? `<break time="${slien}ms" />` : '';
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN">
        <voice name="${voiceName}">
            <mstts:express-as style="${style}" styledegree="2.0" role="default">
                <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escaped}</prosody>
            </mstts:express-as>
            ${breakTag}
        </voice>
    </speak>`;
}

async function getEndpoint(env, ctx) {
    // 1. 同一 Isolate 内部单飞锁：已有鉴权请求在飞时直接复用，不重复发起网络握手
    if (pendingTokenPromise) {
        return await pendingTokenPromise;
    }

    pendingTokenPromise = (async () => {
        try {
            return await resolveToken(env, ctx);
        } finally {
            pendingTokenPromise = null;
        }
    })();

    return await pendingTokenPromise;
}

async function resolveToken(env, ctx) {
    const now = Date.now() / 1000;

    // 2. 检查 L1 内存缓存
    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    const KV_KEY = "ms_edge_tts_endpoint_token";
    const CACHE_URL = "https://ms-tts-token.internal/cache";

    // 3. 检查 L2 分布式缓存 (优先 Cloudflare KV，未绑定时降级为 Cache API)
    if (env && env.TTS_KV) {
        try {
            const kvData = await env.TTS_KV.get(KV_KEY, "json");
            if (kvData && kvData.expiredAt && now < kvData.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
                tokenInfo = kvData;
                return tokenInfo.endpoint;
            }
        } catch (err) {
            console.warn("KV 读取失败，降级处理:", err);
        }
    } else {
        try {
            const cache = caches.default;
            const cacheRes = await cache.match(CACHE_URL);
            if (cacheRes) {
                const edgeData = await cacheRes.json();
                if (edgeData && edgeData.expiredAt && now < edgeData.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
                    tokenInfo = edgeData;
                    return tokenInfo.endpoint;
                }
            }
        } catch (err) {
            console.warn("Cache API 读取跳过:", err);
        }
    }

    // 4. L1/L2 均未命中，执行微软移动端签名换取 JWT 凭据
    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");

    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Accept-Language": "zh-Hans",
                "X-ClientVersion": "4.0.530a 5fe1dc6c",
                "X-UserId": "0f04d16a175c411e",
                "X-HomeGeographicRegion": "zh-Hans-CN",
                "X-ClientTraceId": clientId,
                "X-MT-Signature": await sign(endpointUrl),
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": "0"
            }
        });

        if (!response.ok) {
            const err = new Error(`微软鉴权握手失败 (HTTP ${response.status})`);
            err.step = "AUTH_TOKEN";
            err.status = response.status;
            err.details = await response.text();
            throw err;
        }

        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));

        // 更新 L1 本地内存
        tokenInfo = {
            endpoint: data,
            token: data.t,
            expiredAt: decodedJwt.exp
        };

        // 写入 L2 缓存并计算有效生命周期 (TTL)
        const remainingTtl = Math.max(60, Math.floor(decodedJwt.exp - now - TOKEN_REFRESH_BEFORE_EXPIRY));

        if (env && env.TTS_KV) {
            const kvPromise = env.TTS_KV.put(KV_KEY, JSON.stringify(tokenInfo), {
                expirationTtl: remainingTtl
            }).catch(e => console.error("KV 写入失败:", e));

            if (ctx && ctx.waitUntil) ctx.waitUntil(kvPromise);
        } else {
            const cache = caches.default;
            const cacheResponse = new Response(JSON.stringify(tokenInfo), {
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": `public, max-age=${remainingTtl}`
                }
            });
            const cachePromise = cache.put(CACHE_URL, cacheResponse).catch(e => console.error("Cache 写入失败:", e));

            if (ctx && ctx.waitUntil) ctx.waitUntil(cachePromise);
        }

        return data;
    } catch (e) {
        if (!e.step) {
            e.step = "AUTH_TOKEN";
            e.status = 502;
        }
        throw e;
    }
}

function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400"
    };
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: { name: "SHA-256" } }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data)));
}

async function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = crypto.randomUUID().replace(/-/g, "");
    const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim().toLowerCase() + " gmt";
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const signData = await hmacSha256(decode, bytesToSign);
    return `MSTranslatorAndroidApp::${await bytesToBase64(signData)}::${formattedDate}::${uuidStr}`;
}
