/**
 * Cloudflare Worker: Edge TTS + DeepSeek 智能命题一体化网关
 */

const TOKEN_REFRESH_BEFORE_EXPIRY = 3 * 60;

let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

let pendingTokenPromise = null;

const OPENAI_VOICE_MAP = {
    "alloy": "zh-CN-XiaoxiaoNeural",
    "echo": "zh-CN-YunxiNeural",
    "fable": "en-US-GuyNeural",
    "onyx": "zh-CN-YunjianNeural",
    "nova": "zh-CN-XiaoyiNeural",
    "shimmer": "zh-CN-XiaoxuanNeural"
};

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
    <title>TTS & 听说考试 AI 命题平台</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232563eb'><path d='M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z'/><path d='M19 10v2a7 7 0 0 1-14 0v-2'/><line x1='12' y1='19' x2='12' y2='22' stroke='%232563eb' stroke-width='2.5'/></svg>">
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --bg: #0f172a;
            --surface: rgba(255, 255, 255, 0.35);
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
            --surface: rgba(15, 23, 42, 0.52);
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
            max-width: 880px;
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
            min-height: 140px;
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
            min-height: 220px;
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
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 14px;
            margin-bottom: 18px;
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

        .ai-exam-box {
            background: rgba(37, 99, 235, 0.08);
            border: 1px solid rgba(37, 99, 235, 0.3);
            border-radius: var(--radius-md);
            padding: 12px 16px;
            margin-bottom: 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
        }
        .ai-exam-box:hover {
            border-color: var(--primary);
        }
        .ai-exam-title {
            font-weight: 700;
            font-size: 0.88rem;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ai-exam-desc {
            font-size: 0.76rem;
            color: var(--text-secondary);
            margin-top: 2px;
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
            padding: 8px 16px;
            border-radius: var(--radius-md);
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-weight: 700;
            font-size: 0.84rem;
        }
        .btn-secondary:hover {
            background: #059669;
        }

        .exam-card {
            margin-top: 20px;
            background: var(--surface);
            border: 1.5px solid var(--border);
            border-radius: var(--radius-lg);
            padding: 18px;
            display: none;
        }
        .exam-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--border);
        }
        .exam-badge {
            background: rgba(37, 99, 235, 0.15);
            color: var(--primary);
            font-size: 0.74rem;
            font-weight: 700;
            padding: 2px 8px;
            border-radius: 999px;
        }
        .exam-body {
            background: var(--surface-sub);
            border-radius: var(--radius-md);
            padding: 14px;
            font-family: inherit;
            font-size: 0.88rem;
            line-height: 1.7;
            white-space: pre-wrap;
            max-height: 420px;
            overflow-y: auto;
            border: 1px solid var(--border);
        }
        .btn-copy {
            background: var(--surface);
            border: 1px solid var(--border);
            color: var(--text-primary);
            padding: 5px 12px;
            font-size: 0.78rem;
            font-weight: 600;
            border-radius: var(--radius-sm);
            cursor: pointer;
        }
        .btn-copy:hover {
            color: var(--primary);
            border-color: var(--primary);
        }
        .loading-spinner {
            width: 26px;
            height: 26px;
            border: 3px solid var(--border);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin: 10px auto;
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
                        <button type="button" class="tab-btn" id="textTab">手动输入</button>
                        <button type="button" class="tab-btn active" id="ssmlTab">&lt; &gt; SSML 剧本模式</button>
                    </div>
                </div>

                <div class="form-group" id="textArea" style="display: none;">
                    <label class="form-label" for="textInput">文本内容</label>
                    <textarea class="form-textarea" id="textInput" placeholder="输入要转换的文本..."></textarea>
                </div>

                <div class="form-group" id="ssmlArea">
                    <div class="template-picker">
                        <label class="form-label" style="margin:0; min-width:80px;">快速模板:</label>
                        <select class="template-select" id="templateSelect">
                            <option value="">载入预设英语人机对话考试题型...</option>
                            <option value="examDemo" selected>中高考人机对话 (Part B 角色扮演 + Part C 故事复述)</option>
                        </select>
                    </div>
                    <textarea class="form-textarea ssml-editor" id="ssmlInput"></textarea>
                </div>

                <div class="controls-grid">
                    <div class="form-group">
                        <label class="form-label" for="voiceSelect">发音人 (通用)</label>
                        <select class="form-select" id="voiceSelect">
                            <option value="en-US-GuyNeural" selected>Guy (美语男声 - 常用旁白/男考生)</option>
                            <option value="en-US-JennyNeural">Jenny (美语女声 - 常用对话/女考生)</option>
                            <option value="zh-CN-YunxiNeural">云希 (中文标准普通话)</option>
                            <option value="zh-CN-XiaoxiaoNeural">晓晓 (中文温柔女声)</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="formatSelect">音频品质</label>
                        <select class="form-select" id="formatSelect">
                            <option value="audio-24khz-160kbitrate-mono-mp3" selected>MP3 高保真 (160 kbps)</option>
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

                <label class="ai-exam-box" for="aiExamToggle">
                    <div>
                        <div class="ai-exam-title">
                            <span>✨</span> 开启 DeepSeek 智能听说命题 (人机对话逆向出题)
                        </div>
                        <div class="ai-exam-desc">
                            基于 DeepSeek 驱动，精准提取上下文并按中高考听说标准格式生成 Part B (三问五答) 与 Part C。
                        </div>
                    </div>
                    <input type="checkbox" id="aiExamToggle" style="width: 20px; height: 20px; accent-color: var(--primary); cursor: pointer;" checked>
                </label>

                <button type="submit" class="btn-primary" id="generateBtn">
                    <span>🎙️</span>
                    <span>立即开始合成 (与同步出题)</span>
                </button>
            </form>

            <div id="result" class="result-container">
                <div id="audioLoading" style="display: none; text-align: center; padding: 12px 0;">
                    <div class="loading-spinner"></div>
                    <div style="font-size:0.84rem; color:var(--text-secondary);">正在合成音频并建立流式连接...</div>
                </div>

                <div id="audioSuccess" style="display: none;">
                    <div style="font-size:0.85rem; font-weight:700; color:#10b981; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                        <span>✓</span> 音频生成完毕
                    </div>
                    <audio id="audioPlayer" class="audio-player" controls preload="auto"></audio>
                    <a id="downloadBtn" class="btn-secondary" download="speech.mp3">
                        <span>📥</span>
                        <span>下载音频文件</span>
                    </a>
                </div>
            </div>

            <div id="examCard" class="exam-card">
                <div class="exam-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-weight:700; font-size:0.92rem;">📝 英语听说考试标准试卷 (DeepSeek 生成)</span>
                        <span class="exam-badge" id="examBadge">DeepSeek 命题中...</span>
                    </div>
                    <button type="button" class="btn-copy" id="copyExamBtn">📋 复制试题</button>
                </div>
                <div id="examLoading" style="display:none; text-align:center; padding:18px 0;">
                    <div class="loading-spinner"></div>
                    <div style="font-size:0.82rem; color:var(--text-secondary);">DeepSeek 正在解析对话逻辑并组织命题点...</div>
                </div>
                <pre class="exam-body" id="examBody"></pre>
            </div>
        </div>
    </main>

    <script>
        const DEFAULT_EXAM_SSML = \`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <!-- ========== Part B 角色扮演对话 ========== -->
  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Hi Linda, I heard our school will hold a sports meeting next month.</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-JennyNeural">
    <prosody rate="-20%">Yes, that’s right. Are you going to take part in any sports events?</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Of course. I plan to join the 100-meter running race.</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-JennyNeural">
    <prosody rate="-20%">That’s cool! When will the school start the registration?</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">The registration starts next Monday and lasts for three days.</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-JennyNeural">
    <prosody rate="-20%">Don’t forget to bring your student ID when you sign up for the race.</prosody>
    <break time="800ms" />
  </voice>

  <!-- ========== Part C 故事复述独白（男声） ========== -->
  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Tom is a hard-working middle school student. Last weekend, he planned to finish all his homework first. In the afternoon, he found his deskmate Lily was upset because she could not solve her math problems. Tom decided to help her patiently. They studied together for two hours, and Lily finally understood all the difficult points. Lily thanked Tom warmly. Tom felt very happy to help his classmate.</prosody>
  </voice>
</speak>\`;

        document.getElementById('ssmlInput').value = DEFAULT_EXAM_SSML;

        const bg = document.getElementById('bgOverlay');
        if (bg) bg.style.backgroundImage = "url('/api/wallpaper?t=" + Date.now() + "')";

        const themeToggle = document.getElementById('themeToggle');
        const themeIcon = document.getElementById('themeIcon');
        function applyTheme(theme) {
            document.documentElement.setAttribute('data-theme', theme);
            localStorage.setItem('tts_theme', theme);
            themeIcon.innerHTML = theme === 'dark' 
                ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
                : '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
        }
        themeToggle.onclick = function() {
            applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        };
        applyTheme(localStorage.getItem('tts_theme') || 'light');

        function pad(n) { return n < 10 ? '0' + n : n; }
        function updateCountdowns() {
            const now = new Date();
            const bjTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (8 * 3600000));
            const nowMs = bjTime.getTime();
            const y = bjTime.getFullYear(), m = bjTime.getMonth(), d = bjTime.getDate();

            const todayEnd = new Date(y, m, d + 1, 0, 0, 0).getTime();
            const remDay = Math.max(0, todayEnd - nowMs);
            document.getElementById('dayPercent').textContent = ((remDay / 86400000) * 100).toFixed(2) + '%';
            document.getElementById('dayExact').textContent = '剩余 ' + pad(Math.floor(remDay / 3600000)) + ':' + pad(Math.floor((remDay % 3600000) / 60000)) + ':' + pad(Math.floor((remDay % 60000) / 1000));

            const yStart = new Date(y, 0, 1).getTime(), yEnd = new Date(y + 1, 0, 1).getTime();
            const remYear = Math.max(0, yEnd - nowMs);
            document.getElementById('yearPercent').textContent = ((remYear / (yEnd - yStart)) * 100).toFixed(2) + '%';
            document.getElementById('yearExact').textContent = '剩余 ' + Math.floor(remYear / 86400000) + '天';

            const gkTarget = new Date(2028, 5, 7, 9, 0, 0).getTime();
            const remGk = Math.max(0, gkTarget - nowMs);
            document.getElementById('gaokaoPercent').textContent = ((remGk / (gkTarget - new Date(2025, 8, 1).getTime())) * 100).toFixed(2) + '%';
            document.getElementById('gaokaoExact').textContent = '剩余 ' + Math.floor(remGk / 86400000) + '天';
        }
        setInterval(updateCountdowns, 1000);
        updateCountdowns();

        let activeTab = 'ssml';
        const textTab = document.getElementById('textTab');
        const ssmlTab = document.getElementById('ssmlTab');
        const textArea = document.getElementById('textArea');
        const ssmlArea = document.getElementById('ssmlArea');

        textTab.onclick = function() {
            activeTab = 'text';
            textTab.classList.add('active'); ssmlTab.classList.remove('active');
            textArea.style.display = 'block'; ssmlArea.style.display = 'none';
        };
        ssmlTab.onclick = function() {
            activeTab = 'ssml';
            ssmlTab.classList.add('active'); textTab.classList.remove('active');
            ssmlArea.style.display = 'block'; textArea.style.display = 'none';
        };

        const speedInput = document.getElementById('speedInput');
        const pitchInput = document.getElementById('pitchInput');
        speedInput.oninput = function() { document.getElementById('speedVal').textContent = parseFloat(speedInput.value).toFixed(2) + 'x'; };
        pitchInput.oninput = function() { document.getElementById('pitchVal').textContent = (pitchInput.value >= 0 ? '+' : '') + pitchInput.value + 'Hz'; };

        document.getElementById('copyExamBtn').onclick = function() {
            const content = document.getElementById('examBody').textContent;
            if (!content) return;
            navigator.clipboard.writeText(content).then(() => alert('试题已成功复制到剪贴板！'));
        };

        document.getElementById('ttsForm').onsubmit = async function(e) {
            e.preventDefault();
            const text = activeTab === 'text' ? document.getElementById('textInput').value : document.getElementById('ssmlInput').value;
            if (!text.trim()) {
                alert('请输入待转换的内容');
                return;
            }

            const enableExam = document.getElementById('aiExamToggle').checked;
            const generateBtn = document.getElementById('generateBtn');
            const resultBox = document.getElementById('result');
            const audioLoading = document.getElementById('audioLoading');
            const audioSuccess = document.getElementById('audioSuccess');
            const audioPlayer = document.getElementById('audioPlayer');
            const downloadBtn = document.getElementById('downloadBtn');

            const examCard = document.getElementById('examCard');
            const examLoading = document.getElementById('examLoading');
            const examBody = document.getElementById('examBody');
            const examBadge = document.getElementById('examBadge');

            generateBtn.disabled = true;
            resultBox.style.display = 'block';
            audioLoading.style.display = 'block';
            audioSuccess.style.display = 'none';

            if (enableExam) {
                examCard.style.display = 'block';
                examLoading.style.display = 'block';
                examBody.textContent = '';
                examBadge.textContent = 'DeepSeek 命题中...';
            } else {
                examCard.style.display = 'none';
            }

            const audioTask = fetch('/v1/audio/speech', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: text,
                    voice: document.getElementById('voiceSelect').value,
                    outputFormat: document.getElementById('formatSelect').value,
                    speed: parseFloat(speedInput.value),
                    pitch: pitchInput.value + 'Hz'
                })
            }).then(async res => {
                if (!res.ok) throw new Error((await res.json()).error?.message || '音频合成失败');
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                audioPlayer.src = url;
                downloadBtn.href = url;
                audioLoading.style.display = 'none';
                audioSuccess.style.display = 'block';
            }).catch(err => {
                audioLoading.style.display = 'none';
                alert('音频生成异常: ' + err.message);
            });

            let examTask = Promise.resolve();
            if (enableExam) {
                examTask = fetch('/api/generate-exam', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: text })
                }).then(async res => {
                    const data = await res.json();
                    examLoading.style.display = 'none';
                    if (!res.ok || data.error) {
                        examBody.textContent = '试题生成失败: ' + (data.error || '未知错误');
                        examBadge.textContent = '失败';
                    } else {
                        examBody.textContent = data.result;
                        examBadge.textContent = '生成完毕';
                    }
                }).catch(err => {
                    examLoading.style.display = 'none';
                    examBody.textContent = '请求异常: ' + err.message;
                    examBadge.textContent = '错误';
                });
            }

            await Promise.allSettled([audioTask, examTask]);
            generateBtn.disabled = false;
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
            const targetUrl = isMobile ? "https://t.alcy.cc/mp" : "https://t.alcy.cc/pc";

            const imgRes = await fetch(targetUrl, {
                headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.pixiv.net/" },
                redirect: "follow"
            });
            return new Response(imgRes.body, {
                headers: { "Content-Type": imgRes.headers.get("Content-Type") || "image/jpeg", ...makeCORSHeaders() }
            });
        } catch {
            return Response.redirect("https://picsum.photos/1920/1080", 302);
        }
    }

    // ==================== DeepSeek AI 试题生成 ====================
    if (path === "/api/generate-exam") {
        if (!env.AI) {
            return new Response(JSON.stringify({
                error: "未在 wrangler.toml 中开启 Workers AI 绑定。请添加 [ai] binding = 'AI'"
            }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        }

        try {
            const { text } = await request.json();
            if (!text || !text.trim()) {
                return new Response(JSON.stringify({ error: "文本内容不能为空" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
                });
            }

            const systemPrompt = `你是一名资深的英语听说人机对话考试命题专家。
用户会提供一段 SSML 剧本或对话文本（包含两部分：Part B 角色扮演对话，Part C 故事复述短文）。
请深入理解文本的上下文细节，严格按照中考/高考人机对话考试的规范格式进行命题。

【输出规范】：
严格按照以下格式直接输出试题，禁止包含多余的问候、解释或前导说明：

二、Part B 角色扮演 原题

情景介绍

角色：你是学生
任务：1. 根据中文提示，向对方提3个问题；2. 回答电脑的5个问题

三问（中文提示）

1. [根据对话中的关键点，提出第1个中文提问提示]
2. [根据对话中的关键点，提出第2个中文提问提示]
3. [根据对话中的关键点，提出第3个中文提问提示]

五答（听力问答）

1. [根据对话细节，提出第1个英文问句]
2. [根据对话细节，提出第2个英文问句]
3. [根据对话细节，提出第3个英文问句]
4. [根据对话细节，提出第4个英文问句]
5. [根据对话细节，提出第5个英文问句]

三、Part C 故事复述 原题

故事梗概

[用一句话精炼概括短文故事的核心情节]

关键词

[列出5-7个核心考点英文单词或短语，用英文逗号分隔]`;

            // 调用 Cloudflare Workers AI 原生 DeepSeek 模型
            const aiResponse = await env.AI.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", {
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `请根据以下考试材料进行命题：\n\n${text}` }
                ],
                max_tokens: 2048,
                temperature: 0.6
            });

            // 过滤 DeepSeek-R1 的思考标签，仅保留纯净试卷排版
            let cleanResult = (aiResponse.response || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

            return new Response(JSON.stringify({ result: cleanResult }), {
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        } catch (error) {
            console.error("DeepSeek 命题失败:", error);
            return new Response(JSON.stringify({ error: error.message || "DeepSeek 服务异常" }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        }
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
            return new Response(JSON.stringify({ error: { message: error.message || "服务内部异常" } }), {
                status: 500,
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

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function optimizedTextSplit(text, maxChunkSize = 1500) {
    const chunks = [];
    const sentences = text.split(/[。！？\n]/);
    let currentChunk = '';
    for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;
        if (trimmed.length > maxChunkSize) {
            if (currentChunk) { chunks.push(currentChunk.trim()); currentChunk = ''; }
            for (let i = 0; i < trimmed.length; i += maxChunkSize) chunks.push(trimmed.slice(i, i + maxChunkSize));
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

async function getVoice(text, voiceName, rate, pitch, volume, style, outputFormat, env, ctx) {
    const cleanText = (text || "").trim();
    if (!cleanText) throw new Error("输入文本为空");

    const isWav = outputFormat.includes("pcm");
    const mimeType = isWav ? "audio/wav" : "audio/mpeg";

    if (cleanText.startsWith('<speak') || cleanText.length <= 1500) {
        const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat, 3, env, ctx);
        return new Response(audioBlob, { headers: { "Content-Type": mimeType, ...makeCORSHeaders() } });
    }

    const chunks = optimizedTextSplit(cleanText, 1500);
    const audioChunks = await processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, env, ctx);
    return new Response(new Blob(audioChunks, { type: mimeType }), {
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
                    "User-Agent": "Mozilla/5.0",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: requestSsml
            });

            if (!response.ok) {
                if (attempt < maxRetries && response.status >= 500) {
                    await delay(500 * (attempt + 1));
                    continue;
                }
                throw new Error(`Edge TTS 合成拒绝 (HTTP ${response.status})`);
            }

            return await response.blob();
        } catch (e) {
            if (attempt === maxRetries) throw e;
            await delay(500 * (attempt + 1));
        }
    }
}

function escapeXmlText(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function getSsml(text, voiceName, rate, pitch, volume, style, slien = 0) {
    if (text.trim().startsWith('<speak')) return text.trim();
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
    if (pendingTokenPromise) return await pendingTokenPromise;
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
    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    const KV_KEY = "ms_edge_tts_endpoint_token";
    const CACHE_URL = "https://ms-tts-token.internal/cache";

    if (env && env.TTS_KV) {
        try {
            const kvData = await env.TTS_KV.get(KV_KEY, "json");
            if (kvData && kvData.expiredAt && now < kvData.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
                tokenInfo = kvData;
                return tokenInfo.endpoint;
            }
        } catch {}
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
        } catch {}
    }

    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");

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

    if (!response.ok) throw new Error(`微软鉴权失败 (HTTP ${response.status})`);

    const data = await response.json();
    const jwt = data.t.split(".")[1];
    const decodedJwt = JSON.parse(atob(jwt));

    tokenInfo = { endpoint: data, token: data.t, expiredAt: decodedJwt.exp };
    const remainingTtl = Math.max(60, Math.floor(decodedJwt.exp - now - TOKEN_REFRESH_BEFORE_EXPIRY));

    if (env && env.TTS_KV) {
        const kvP = env.TTS_KV.put(KV_KEY, JSON.stringify(tokenInfo), { expirationTtl: remainingTtl });
        if (ctx && ctx.waitUntil) ctx.waitUntil(kvP);
    } else {
        const cacheP = caches.default.put(CACHE_URL, new Response(JSON.stringify(tokenInfo), {
            headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${remainingTtl}` }
        }));
        if (ctx && ctx.waitUntil) ctx.waitUntil(cacheP);
    }

    return data;
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
