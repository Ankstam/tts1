/**
 * Cloudflare Worker: 广东高考英语听说考试 (COT) 命题与 Edge TTS 一体化网关
 * 特性：
 * 1. 后端安全读取 Cloudflare 环境变量机密 (GROQ_API_KEY, ZHIPU_API_KEY)
 * 2. 深度净化 SSML 裸露 break 与注释，杜绝 Edge TTS HTTP 400
 * 3. 支持智谱清言 (GLM 系列)、Groq (120B/27B/20B) 与 CF 原生 DeepSeek
 * 4. 广东高考听说考试严格信息链闭环命题与答案折叠
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

const DEFAULT_COT_SYSTEM_PROMPT = `你是一名精通广东省普通高考英语听说考试（Computerized Oral Test，简称 COT）命题规则与智能机评算法的权威命题专家。
用户会提供一段 SSML 剧本或对话文本，通常包含：
1. Part B 角色扮演材料（双人交替日常对话）
2. Part C 故事复述材料（单人独白记叙文）

请严格执行【广东省高考英语听说考试】命题规范与信息依赖链条进行命题，保持语言精炼，杜绝多余开场白：

【命题核心铁律】：
1. Part B 角色扮演：
   - 三问（中文提示）：给出3个引导考生向对方提问的中文提示。
   - 电脑答语：必须基于输入对话事实，给出【电脑对这3个提问的英文答语】（Computer's Response 1, 2, 3）。
   - 五答题源分布：
     * Question 1、Question 2：问题答案【必须且只能】来自初始原对话的事实！
     * Question 3：问题答案【必须且只能】针对【电脑对第1问的答语】提问！
     * Question 4：问题答案【必须且只能】针对【电脑对第2问的答语】提问！
     * Question 5：问题答案【必须且只能】针对【电脑对第3问的答语】提问！
2. Part C 故事复述：
   - 故事梗概：用 30-50 字中文精炼总结短文情节。
   - 关键词：严格精选【5个中英文对照关键词/词组】，必须【严格按照故事时间先后顺序】排列！
   - 核心采分点：提炼 6-8 个机评采分关键信息点。
3. 答案规范：
   - 三问标准句式：直接疑问句。
   - 五答标准答案：完整句与核心简答。
   - 复述范文：全篇严格使用一般过去时（Past Tense），约 100 词。

【输出格式要求】：
严格分为 <EXAM> 试题 和 <ANSWER> 参考答案 两部分：

<EXAM>
二、Part B 角色扮演 原题

情景介绍
角色：你是学生
任务：1. 根据中文提示提3个问题；2. 回答电脑的5个问题

三问（中文提示）
1. [中文提问提示 1]
2. [中文提问提示 2]
3. [中文提问提示 3]

五答（听力问答）
1. [基于原对话事实的英文提问 1]
2. [基于原对话事实的英文提问 2]
3. [基于电脑对第1问答语的提问 3]
4. [基于电脑对第2问答语的提问 4]
5. [基于电脑对第3问答语的提问 5]

三、Part C 故事复述 原题

故事梗概
[30-50字中文梗概]

关键词
[关键词1], [关键词2], [关键词3], [关键词4], [关键词5]
</EXAM>

<ANSWER>
Part B 电脑答语
1. [电脑答语 1]
2. [电脑答语 2]
3. [电脑答语 3]

Part B 三问标准句式
1. [三问第1题]
2. [三问第2题]
3. [三问第3题]

Part B 五答标准答语
1. 完整句：[...] | 简答：[...]
2. 完整句：[...] | 简答：[...]
3. 完整句：[...] | 简答：[...]
4. 完整句：[...] | 简答：[...]
5. 完整句：[...] | 简答：[...]

Part C 机评采分点
1. [...] 2. [...] 3. [...] 4. [...] 5. [...] 6. [...]

Part C 高分复述范文（全篇过去时）
[...]
</ANSWER>`;

const HTML_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>广东高考英语听说考试模拟平台</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%232563eb'><path d='M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z'/><path d='M19 10v2a7 7 0 0 1-14 0v-2'/><line x1='12' y1='19' x2='12' y2='22' stroke='%232563eb' stroke-width='2.5'/></svg>">
    <style>
        :root {
            --primary: #2563eb;
            --primary-hover: #1d4ed8;
            --bg: #0f172a;
            --surface: rgba(255, 255, 255, 0.40);
            --surface-sub: rgba(255, 255, 255, 0.25);
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
            --surface: rgba(15, 23, 42, 0.55);
            --surface-sub: rgba(15, 23, 42, 0.38);
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
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background-size: cover; background-position: center; background-repeat: no-repeat;
            z-index: -2; transition: opacity 0.5s ease-in-out;
        }
        #bgMask {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(15, 23, 42, 0.08); z-index: -1;
        }
        [data-theme="dark"] #bgMask { background: rgba(11, 15, 25, 0.45); }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: var(--text-primary); line-height: 1.6; min-height: 100vh; transition: color 0.25s ease;
        }

        .float-theme-btn {
            position: fixed; top: 16px; right: 16px; z-index: 100;
            background: var(--surface); backdrop-filter: blur(16px) saturate(180%);
            -webkit-backdrop-filter: blur(16px) saturate(180%); border: 1px solid var(--border);
            color: var(--text-secondary); width: 38px; height: 38px; border-radius: 50%;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            box-shadow: var(--shadow-sm); transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .float-theme-btn:hover { color: var(--primary); border-color: var(--primary); transform: scale(1.08); }

        .container { max-width: 880px; margin: 0 auto; padding: 24px 16px 60px; }

        .countdown-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
        @media (max-width: 640px) { .countdown-grid { grid-template-columns: 1fr; } }

        .countdown-card {
            background: var(--surface); backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--border);
            border-radius: var(--radius-lg); padding: 14px 12px; text-align: center; box-shadow: var(--shadow-sm);
        }
        .countdown-label { font-size: 0.76rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 4px; }
        .countdown-percentage {
            font-size: 1.7rem; font-weight: 800; color: var(--primary);
            font-family: "JetBrains Mono", Consolas, monospace; line-height: 1.15;
        }
        .countdown-exact {
            font-size: 0.74rem; font-weight: 600; color: var(--text-secondary); margin-top: 4px;
            font-family: "JetBrains Mono", Consolas, monospace;
        }

        .main-card {
            background: var(--surface); backdrop-filter: blur(20px) saturate(180%);
            -webkit-backdrop-filter: blur(20px) saturate(180%); border-radius: var(--radius-xl);
            box-shadow: var(--shadow-lg); border: 1px solid var(--border); padding: 24px;
        }
        .form-group { margin-bottom: 18px; }
        .form-label { display: block; margin-bottom: 8px; font-weight: 700; font-size: 0.88rem; color: var(--text-primary); }
        .input-method-tabs {
            display: flex; gap: 6px; background: var(--surface-sub); padding: 4px;
            border-radius: var(--radius-lg); border: 1px solid var(--border);
        }
        .tab-btn {
            flex: 1; padding: 9px 14px; border: none; background: transparent;
            color: var(--text-secondary); border-radius: var(--radius-md); font-size: 0.88rem;
            font-weight: 700; cursor: pointer; transition: all 0.2s;
        }
        .tab-btn.active { background: var(--primary); color: #ffffff; box-shadow: var(--shadow-sm); }

        .form-textarea {
            width: 100%; min-height: 140px; padding: 12px 14px; border: 1.5px solid var(--border);
            border-radius: var(--radius-md); font-size: 0.95rem; font-weight: 500; background: var(--surface-sub);
            color: var(--text-primary); font-family: inherit; resize: vertical;
        }
        .form-textarea.ssml-editor { font-family: "JetBrains Mono", Consolas, monospace; font-size: 0.86rem; min-height: 220px; }
        .form-textarea:focus, .form-select:focus {
            outline: none; background: rgba(255, 255, 255, 0.45); border-color: var(--border-focus);
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
        }

        .controls-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 18px; }
        .form-select {
            width: 100%; padding: 9px 12px; border: 1.5px solid var(--border); border-radius: var(--radius-md);
            font-size: 0.88rem; font-weight: 600; color: var(--text-primary); background: var(--surface-sub);
        }
        .slider-label-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .slider-val { font-size: 0.82rem; color: var(--primary); font-weight: 700; }
        .form-range { width: 100%; accent-color: var(--primary); cursor: pointer; }

        /* AI 命题配置面板 */
        .ai-exam-box {
            background: rgba(37, 99, 235, 0.08); border: 1.5px solid rgba(37, 99, 235, 0.3);
            border-radius: var(--radius-lg); padding: 14px 16px; margin-bottom: 18px;
        }
        .ai-exam-header {
            display: flex; align-items: center; justify-content: space-between; cursor: pointer;
        }
        .ai-exam-title {
            font-weight: 700; font-size: 0.90rem; color: var(--text-primary); display: flex; align-items: center; gap: 8px;
        }
        .ai-exam-desc { font-size: 0.76rem; color: var(--text-secondary); margin-top: 2px; }

        .ai-config-panel {
            margin-top: 14px; padding-top: 12px; border-top: 1px dashed rgba(37, 99, 235, 0.25);
            display: flex; flex-direction: column; gap: 12px;
        }
        .ai-grid-row {
            display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px;
        }

        .prompt-accordion-btn {
            background: transparent; border: none; color: var(--primary);
            font-size: 0.80rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
            padding: 4px 0; text-decoration: underline;
        }
        .prompt-edit-container { display: none; margin-top: 8px; }

        .btn-primary {
            width: 100%; background: var(--primary); color: #ffffff; border: none; padding: 13px;
            font-size: 0.96rem; font-weight: 700; border-radius: var(--radius-md); cursor: pointer;
            transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
        }
        .btn-primary:hover:not(:disabled) { background: var(--primary-hover); transform: translateY(-1px); }
        .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

        .result-container {
            margin-top: 22px; padding: 18px; background: var(--surface-sub);
            border-radius: var(--radius-lg); border: 1px solid var(--border); display: none;
        }
        .audio-player { width: 100%; margin-bottom: 14px; display: block; }
        .btn-secondary {
            background: #10b981; color: #ffffff; border: none; padding: 8px 16px; border-radius: var(--radius-md);
            cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 8px;
            font-weight: 700; font-size: 0.84rem;
        }

        .exam-card {
            margin-top: 20px; background: var(--surface); border: 1.5px solid var(--border);
            border-radius: var(--radius-lg); padding: 18px; display: none;
        }
        .exam-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border);
        }
        .exam-badge {
            background: rgba(37, 99, 235, 0.15); color: var(--primary); font-size: 0.74rem;
            font-weight: 700; padding: 2px 8px; border-radius: 999px;
        }
        .exam-body {
            background: var(--surface-sub); border-radius: var(--radius-md); padding: 14px;
            font-family: inherit; font-size: 0.88rem; line-height: 1.7; white-space: pre-wrap;
            max-height: 420px; overflow-y: auto; border: 1px solid var(--border);
        }
        .btn-copy {
            background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);
            padding: 5px 12px; font-size: 0.78rem; font-weight: 600; border-radius: var(--radius-sm); cursor: pointer;
        }
        .btn-copy:hover { color: var(--primary); border-color: var(--primary); }

        .answer-container { margin-top: 16px; border-top: 1px dashed var(--border); padding-top: 14px; }
        .btn-toggle-answer {
            width: 100%; background: var(--surface-sub); border: 1.5px solid var(--border); color: var(--text-primary);
            padding: 10px 14px; border-radius: var(--radius-md); font-size: 0.86rem; font-weight: 700;
            cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: all 0.2s;
        }
        .btn-toggle-answer:hover { background: rgba(37, 99, 235, 0.1); border-color: var(--primary); color: var(--primary); }
        .answer-collapse-box { display: none; margin-top: 12px; }
        .answer-body { background: rgba(16, 185, 129, 0.05); border-color: rgba(16, 185, 129, 0.3); }

        .loading-spinner {
            width: 26px; height: 26px; border: 3px solid var(--border); border-top: 3px solid var(--primary);
            border-radius: 50%; animation: spin 0.8s linear infinite; margin: 10px auto;
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
                <div class="countdown-label">28年高考英语听说 (3月模考)</div>
                <div class="countdown-percentage" id="gaokaoPercent">0.00%</div>
                <div class="countdown-exact" id="gaokaoExact">剩余 0天 00:00:00</div>
            </div>
        </div>

        <div class="main-card">
            <form id="ttsForm">
                <div class="form-group">
                    <label class="form-label">输入模式</label>
                    <div class="input-method-tabs">
                        <button type="button" class="tab-btn" id="textTab">手动输入纯文本</button>
                        <button type="button" class="tab-btn active" id="ssmlTab">&lt; &gt; SSML 对话/独白模式</button>
                    </div>
                </div>

                <div class="form-group" id="textArea" style="display: none;">
                    <label class="form-label" for="textInput">文本内容</label>
                    <textarea class="form-textarea" id="textInput" placeholder="在此输入英文材料..."></textarea>
                </div>

                <div class="form-group" id="ssmlArea">
                    <label class="form-label">SSML 材料编辑 (支持多角色发音人)</label>
                    <textarea class="form-textarea ssml-editor" id="ssmlInput"></textarea>
                </div>

                <div class="controls-grid">
                    <div class="form-group">
                        <label class="form-label" for="voiceSelect">默认播音音色</label>
                        <select class="form-select" id="voiceSelect">
                            <option value="en-US-GuyNeural" selected>Guy (美式男声 - 标准播音/男角色)</option>
                            <option value="en-US-JennyNeural">Jenny (美式女声 - 女角色)</option>
                            <option value="zh-CN-YunxiNeural">云希 (中文普通话)</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="formatSelect">音频品质</label>
                        <select class="form-select" id="formatSelect">
                            <option value="audio-24khz-160kbitrate-mono-mp3" selected>MP3 高保真 (160 kbps)</option>
                            <option value="riff-24khz-16bit-mono-pcm">WAV 无损原音 (24kHz 16Bit)</option>
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

                <!-- AI 听说命题多引擎配置面板 -->
                <div class="ai-exam-box">
                    <div class="ai-exam-header" id="aiExamToggleWrap">
                        <div>
                            <div class="ai-exam-title">
                                <span>✨</span> 开启广东高考听说 AI 智能命题
                            </div>
                            <div class="ai-exam-desc">
                                严格依循广东 COT 规范输出三问五答与故事复述，API Key 已由 Cloudflare 边缘安全托管。
                            </div>
                        </div>
                        <input type="checkbox" id="aiExamToggle" style="width: 20px; height: 20px; accent-color: var(--primary); cursor: pointer;" checked>
                    </div>

                    <div class="ai-config-panel" id="aiConfigPanel">
                        <div class="ai-grid-row">
                            <div>
                                <label class="form-label" style="font-size:0.80rem; margin-bottom:4px;">推理计算引擎</label>
                                <select class="form-select" id="aiProviderSelect">
                                    <option value="zhipu" selected>智谱清言 (GLM 系列大模型)</option>
                                    <option value="groq">Groq 极速云 (LPU 毫秒级加速)</option>
                                    <option value="cf">Cloudflare 自带 (DeepSeek-R1-32B)</option>
                                </select>
                            </div>

                            <div id="zhipuModelWrap">
                                <label class="form-label" style="font-size:0.80rem; margin-bottom:4px;">智谱清言模型 (由强到轻)</label>
                                <select class="form-select" id="zhipuModelSelect">
                                    <option value="glm-4-plus" selected>glm-4-plus (旗舰大模型 · 推理最强)</option>
                                    <option value="glm-4-air">glm-4-air (高性价比 · 均衡优选)</option>
                                    <option value="glm-4-flash">glm-4-flash (极速免费 · 秒级响应)</option>
                                </select>
                            </div>

                            <div id="groqModelWrap" style="display: none;">
                                <label class="form-label" style="font-size:0.80rem; margin-bottom:4px;">Groq 命题模型</label>
                                <select class="form-select" id="groqModelSelect">
                                    <option value="openai/gpt-oss-120b" selected>openai/gpt-oss-120b (120B 旗舰 · 推荐)</option>
                                    <option value="qwen/qwen3.8-27b">qwen/qwen3.8-27b (27B 通义全能)</option>
                                    <option value="openai/gpt-oss-20b">openai/gpt-oss-20b (20B 极速轻量)</option>
                                </select>
                            </div>
                        </div>

                        <div>
                            <button type="button" class="prompt-accordion-btn" id="togglePromptBtn">
                                <span>⚙️ 自定义指示词 (System Prompt) 展开编辑</span>
                            </button>
                            <div class="prompt-edit-container" id="promptEditBox">
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                                    <span style="font-size:0.75rem; color:var(--text-secondary);">留空或未修改时，自动调用系统内置的广东高考 COT 命题指示词</span>
                                    <button type="button" class="btn-copy" id="resetPromptBtn" style="padding:2px 8px; font-size:0.72rem;">↺ 恢复预设</button>
                                </div>
                                <textarea class="form-textarea" id="customPromptInput" style="min-height:160px; font-size:0.82rem; font-family:monospace;"></textarea>
                            </div>
                        </div>
                    </div>
                </div>

                <button type="submit" class="btn-primary" id="generateBtn">
                    <span>🎙️</span>
                    <span>立即开始合成音频与试卷</span>
                </button>
            </form>

            <div id="result" class="result-container">
                <div id="audioLoading" style="display: none; text-align: center; padding: 12px 0;">
                    <div class="loading-spinner"></div>
                    <div style="font-size:0.84rem; color:var(--text-secondary);">正在合成音频并建立传输流...</div>
                </div>

                <div id="audioSuccess" style="display: none;">
                    <div style="font-size:0.85rem; font-weight:700; color:#10b981; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                        <span>✓</span> 考场听力音频已就绪
                    </div>
                    <audio id="audioPlayer" class="audio-player" controls preload="auto"></audio>
                    <a id="downloadBtn" class="btn-secondary" download="cot_exam_audio.mp3">
                        <span>📥</span>
                        <span>下载听力音频 (MP3)</span>
                    </a>
                </div>
            </div>

            <!-- 试卷呈现 -->
            <div id="examCard" class="exam-card">
                <div class="exam-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-weight:700; font-size:0.92rem;">📝 广东省高考英语听说考试标准试题</span>
                        <span class="exam-badge" id="examBadge">AI 命题中...</span>
                    </div>
                    <button type="button" class="btn-copy" id="copyExamBtn">📋 复制试题</button>
                </div>
                <div id="examLoading" style="display:none; text-align:center; padding:18px 0;">
                    <div class="loading-spinner"></div>
                    <div style="font-size:0.82rem; color:var(--text-secondary);">AI 正在解析对话逻辑并组织命题点...</div>
                </div>
                
                <pre class="exam-body" id="examBody"></pre>

                <!-- 答案与范文折叠保护区 -->
                <div class="answer-container" id="answerContainer" style="display: none;">
                    <button type="button" class="btn-toggle-answer" id="toggleAnswerBtn">
                        <span>💡 查看参考答案、电脑答语与评分要点</span>
                        <span id="answerToggleIcon">▼ 点击展开</span>
                    </button>
                    <div class="answer-collapse-box" id="answerCollapseBox">
                        <div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
                            <button type="button" class="btn-copy" id="copyAnswerBtn">📋 复制答案与范文</button>
                        </div>
                        <pre class="exam-body answer-body" id="answerBody"></pre>
                    </div>
                </div>
            </div>
        </div>
    </main>

    <script>
        const DEFAULT_SYSTEM_PROMPT = ${JSON.stringify(DEFAULT_COT_SYSTEM_PROMPT)};
        document.getElementById('customPromptInput').value = DEFAULT_SYSTEM_PROMPT;

        const DEFAULT_EXAM_SSML = \`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <!-- 播报 Part B + 2秒停顿 -->
  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Part B</prosody>
    <break time="2000ms" />
  </voice>

  <!-- ========== Part B 角色扮演对话 ========== -->
  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Hi Emma, our English club will hold a speech competition next Friday.</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-JennyNeural">
    <prosody rate="-20%">That sounds fantastic. What is the theme of this speech competition?</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">The theme is the importance of reading in our daily life.</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-JennyNeural">
    <prosody rate="-20%">How long should each student’s speech last?</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Every speech should be kept within five minutes.</prosody>
    <break time="450ms" />
  </voice>

  <voice name="en-US-JennyNeural">
    <prosody rate="-20%">Don’t forget to hand in your application form before this Wednesday afternoon.</prosody>
    <break time="800ms" />
  </voice>

  <!-- B对话结束，5秒间隔 -->
  <break time="5000ms" />

  <!-- 播报 Part C + 2秒停顿 -->
  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Part C</prosody>
    <break time="2000ms" />
  </voice>

  <!-- ========== Part C 故事复述独白（男声） ========== -->
  <voice name="en-US-GuyNeural">
    <prosody rate="-20%">Last Sunday morning, Mike went to the park for a walk. He noticed a visitor leave his wallet on a bench. Mike picked it up and checked it. Inside the wallet there was some money and an ID card. Mike waited there for nearly one hour. Finally the worried man came back. Mike returned the wallet to him. The man thanked Mike again and again for his honesty.</prosody>
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

            const gkTarget = new Date(2028, 2, 10, 9, 0, 0).getTime();
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

        const aiProviderSelect = document.getElementById('aiProviderSelect');
        const zhipuModelWrap = document.getElementById('zhipuModelWrap');
        const groqModelWrap = document.getElementById('groqModelWrap');

        aiProviderSelect.onchange = function() {
            const provider = this.value;
            zhipuModelWrap.style.display = provider === 'zhipu' ? 'block' : 'none';
            groqModelWrap.style.display = provider === 'groq' ? 'block' : 'none';
        };

        const togglePromptBtn = document.getElementById('togglePromptBtn');
        const promptEditBox = document.getElementById('promptEditBox');
        togglePromptBtn.onclick = function() {
            const isHidden = promptEditBox.style.display === 'none' || promptEditBox.style.display === '';
            promptEditBox.style.display = isHidden ? 'block' : 'none';
            togglePromptBtn.textContent = isHidden ? '▲ 收起自定义指示词编辑' : '⚙️ 自定义指示词 (System Prompt) 展开编辑';
        };

        document.getElementById('resetPromptBtn').onclick = function() {
            document.getElementById('customPromptInput').value = DEFAULT_SYSTEM_PROMPT;
            alert('已恢复为官方预设的广东高考命题指示词！');
        };

        document.getElementById('copyExamBtn').onclick = function() {
            const content = document.getElementById('examBody').textContent;
            if (!content) return;
            navigator.clipboard.writeText(content).then(() => alert('试题已成功复制！'));
        };
        document.getElementById('copyAnswerBtn').onclick = function() {
            const content = document.getElementById('answerBody').textContent;
            if (!content) return;
            navigator.clipboard.writeText(content).then(() => alert('参考答案已成功复制！'));
        };

        const toggleAnswerBtn = document.getElementById('toggleAnswerBtn');
        const answerCollapseBox = document.getElementById('answerCollapseBox');
        const answerToggleIcon = document.getElementById('answerToggleIcon');
        toggleAnswerBtn.onclick = function() {
            const isHidden = answerCollapseBox.style.display === 'none' || answerCollapseBox.style.display === '';
            answerCollapseBox.style.display = isHidden ? 'block' : 'none';
            answerToggleIcon.textContent = isHidden ? '▲ 点击收起' : '▼ 点击展开';
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
            const answerContainer = document.getElementById('answerContainer');
            const answerBody = document.getElementById('answerBody');

            generateBtn.disabled = true;
            resultBox.style.display = 'block';
            audioLoading.style.display = 'block';
            audioSuccess.style.display = 'none';

            if (enableExam) {
                examCard.style.display = 'block';
                examLoading.style.display = 'block';
                examBody.textContent = '';
                answerBody.textContent = '';
                answerContainer.style.display = 'none';
                answerCollapseBox.style.display = 'none';
                answerToggleIcon.textContent = '▼ 点击展开';
                examBadge.textContent = '命题研制中...';
            } else {
                examCard.style.display = 'none';
            }

            // 1. 发起音频合成
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
                if (!res.ok) {
                    const errJson = await res.json().catch(() => ({}));
                    const detailMsg = errJson.error?.details || errJson.error?.message || '音频合成失败 (HTTP ' + res.status + ')';
                    throw new Error(detailMsg);
                }
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

            // 2. 发起 AI 试题生成
            let examTask = Promise.resolve();
            if (enableExam) {
                const provider = aiProviderSelect.value;
                let model = 'glm-4-plus';
                if (provider === 'zhipu') {
                    model = document.getElementById('zhipuModelSelect').value;
                } else if (provider === 'groq') {
                    model = document.getElementById('groqModelSelect').value;
                }

                const customPrompt = document.getElementById('customPromptInput').value.trim();

                examTask = fetch('/api/generate-exam', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: text,
                        provider: provider,
                        model: model,
                        systemPrompt: customPrompt
                    })
                }).then(async res => {
                    const data = await res.json();
                    examLoading.style.display = 'none';
                    if (!res.ok || data.error) {
                        examBody.textContent = '试题生成失败: ' + (data.error || '未知错误');
                        examBadge.textContent = '失败';
                    } else {
                        examBody.textContent = data.exam;
                        if (data.answer) {
                            answerBody.textContent = data.answer;
                            answerContainer.style.display = 'block';
                        }
                        if (provider === 'zhipu') examBadge.textContent = '智谱: ' + model;
                        else if (provider === 'groq') examBadge.textContent = 'Groq: ' + model.split('/')[1];
                        else examBadge.textContent = 'CF: DeepSeek';
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
            headers: { "Content-Type": "text/html; charset=utf-8", ...makeCORSHeaders() }
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

    // ==================== 统一多渠道 AI 命题网关 ====================
    if (path === "/api/generate-exam") {
        try {
            const { text, provider = "zhipu", model = "glm-4-plus", systemPrompt } = await request.json();
            if (!text || !text.trim()) {
                return new Response(JSON.stringify({ error: "文本内容不能为空" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
                });
            }

            const finalPrompt = (systemPrompt && systemPrompt.trim()) ? systemPrompt.trim() : DEFAULT_COT_SYSTEM_PROMPT;
            let rawOutput = "";

            if (provider === "zhipu") {
                const zhipuApiKey = env.ZHIPU_API_KEY;
                if (!zhipuApiKey) {
                    return new Response(JSON.stringify({
                        error: "未在 Cloudflare 后台配置 ZHIPU_API_KEY。请前往 Worker 设置 -> 变量和机密 中添加。"
                    }), {
                        status: 400,
                        headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
                    });
                }

                const zhipuRes = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${zhipuApiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            { role: "system", content: finalPrompt },
                            { role: "user", content: `请根据以下考试材料，严格遵循广东英语听说高考规则命题并研制标准答案：\n\n${text}` }
                        ],
                        temperature: 0.35,
                        max_tokens: 2800
                    })
                });

                if (!zhipuRes.ok) {
                    const errDetail = await zhipuRes.json().catch(() => ({}));
                    throw new Error("智谱 API 拒绝: " + (errDetail.error?.message || `HTTP ${zhipuRes.status}`));
                }

                const zhipuData = await zhipuRes.json();
                rawOutput = (zhipuData.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

            } else if (provider === "groq") {
                const groqApiKey = env.GROQ_API_KEY;
                if (!groqApiKey) {
                    return new Response(JSON.stringify({
                        error: "未在 Cloudflare 后台配置 GROQ_API_KEY。请前往 Worker 设置 -> 变量和机密 中添加。"
                    }), {
                        status: 400,
                        headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
                    });
                }

                const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${groqApiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [
                            { role: "system", content: finalPrompt },
                            { role: "user", content: `请根据以下考试材料，严格遵循广东英语听说高考规则命题并研制标准答案：\n\n${text}` }
                        ],
                        temperature: 0.3,
                        max_tokens: 950
                    })
                });

                if (!groqRes.ok) {
                    const errDetail = await groqRes.json().catch(() => ({}));
                    throw new Error("Groq API 拒绝: " + (errDetail.error?.message || `HTTP ${groqRes.status}`));
                }

                const groqData = await groqRes.json();
                rawOutput = (groqData.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

            } else {
                if (!env.AI) {
                    return new Response(JSON.stringify({
                        error: "未在 wrangler.toml 中绑定 Workers AI。请配置 [ai] binding = 'AI' 或切换为 智谱/Groq 引擎"
                    }), {
                        status: 500,
                        headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
                    });
                }

                const aiResponse = await env.AI.run("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", {
                    messages: [
                        { role: "system", content: finalPrompt },
                        { role: "user", content: `请根据以下考试材料，严格遵循广东英语听说高考规则命题并研制标准答案：\n\n${text}` }
                    ],
                    max_tokens: 2500,
                    temperature: 0.35
                });

                rawOutput = (aiResponse.response || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
            }

            let examContent = rawOutput;
            let answerContent = "";

            const examMatch = rawOutput.match(/<EXAM>([\s\S]*?)<\/EXAM>/i);
            const answerMatch = rawOutput.match(/<ANSWER>([\s\S]*?)<\/ANSWER>/i);

            if (examMatch) examContent = examMatch[1].trim();
            if (answerMatch) answerContent = answerMatch[1].trim();

            return new Response(JSON.stringify({
                exam: examContent,
                answer: answerContent
            }), {
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        } catch (error) {
            console.error("AI 命题失败:", error);
            return new Response(JSON.stringify({ error: error.message || "命题服务异常" }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
            });
        }
    }

    if (path === "/v1/audio/speech") {
        try {
            const requestBody = await request.json();
            const textContent = requestBody.input || requestBody.ssml || requestBody.text || "";
            const rawVoice = requestBody.voice || "en-US-GuyNeural";
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
            return new Response(JSON.stringify({
                error: {
                    message: error.message || "服务内部异常",
                    details: error.details || null
                }
            }), {
                status: error.status || 500,
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

// 健壮级 SSML 语法容错：剔除所有注释，并安全包裹裸露在外面的 break 标签
function sanitizeSsml(ssmlText, defaultVoice = "en-US-GuyNeural") {
    if (!ssmlText || !ssmlText.trim().startsWith('<speak')) return ssmlText;

    let cleaned = ssmlText.replace(/<!--[\s\S]*?-->/g, '');

    cleaned = cleaned.replace(/(<\/voice>|<speak[^>]*>)([\s\S]*?)(<voice[^>]*>|<\/speak>)/gi, (match, p1, middle, p3) => {
        if (/<break/i.test(middle)) {
            const wrappedMiddle = middle.replace(/(<break[^>]*\/>)/gi, `\n  <voice name="${defaultVoice}">$1</voice>\n`);
            return `${p1}${wrappedMiddle}${p3}`;
        }
        return match;
    });

    return cleaned;
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

            let requestSsml = getSsml(text, voiceName, rate, pitch, volume, style, slien);
            requestSsml = sanitizeSsml(requestSsml, voiceName);

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
                const errorDetail = await response.text();
                if (attempt < maxRetries && response.status >= 500) {
                    await delay(500 * (attempt + 1));
                    continue;
                }
                const err = new Error(`Edge TTS 拒绝 (HTTP ${response.status})`);
                err.status = response.status;
                err.details = errorDetail;
                throw err;
            }

            return await response.blob();
        } catch (e) {
            if (attempt === maxRetries || e.status === 400) throw e;
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
