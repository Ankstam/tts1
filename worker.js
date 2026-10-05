export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. TTS 核心合成接口
    if (url.pathname === "/api/tts" && request.method === "POST") {
      const startTime = Date.now();
      try {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({
            error: "未设置环境变量 GEMINI_API_KEY",
            details: {
              code: 500,
              message: "Worker 环境未注入 GEMINI_API_KEY 变量，请在 Cloudflare 控制台添加并绑定。",
              timestamp: new Date().toISOString()
            }
          }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const body = await request.json().catch(() => ({}));
        const {
          text,
          voice = "Fola",
          stylePrompt = "",
          speed = "normal"
        } = body;

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({
            error: "朗读文本不能为空",
            details: {
              code: 400,
              message: "请求体 text 字段为空或未传入有效字符。",
              timestamp: new Date().toISOString()
            }
          }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 标点规整（保护模型断句与停顿）
        const cleanText = text
          .replace(/……/g, "，")
          .replace(/…/g, "，")
          .trim();

        // 组装最终 Style 指令
        const finalStyle = buildFinalStyle(stylePrompt, speed);

        // 构造边缘缓存 Key
        const cachePayload = `${cleanText}_${voice}_${finalStyle}`;
        const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cachePayload));
        const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
        const cache = caches.default;
        const cacheUrl = new URL(`/tts-cache/${hashHex}`, request.url);

        try {
          const cachedResponse = await cache.match(cacheUrl);
          if (cachedResponse) {
            const resp = new Response(cachedResponse.body, cachedResponse);
            resp.headers.set("X-Cache-Status", "HIT");
            return resp;
          }
        } catch (_) {}

        // 对齐 Gemini 3.8 Flash TTS 官方规范
        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: cleanText,
                  speechMetadata: {
                    style: finalStyle
                  }
                }
              ]
            }
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                voice: voice
              }
            }
          }
        };

        const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent?key=${apiKey}`;
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errDetail = await response.text();
          let parsedError = null;
          try {
            parsedError = JSON.parse(errDetail);
          } catch (_) {
            parsedError = { raw: errDetail };
          }

          return new Response(JSON.stringify({
            error: `Google API 请求失败 (${response.status})`,
            details: {
              status: response.status,
              statusText: response.statusText,
              durationMs: Date.now() - startTime,
              googleResponse: parsedError,
              requestMeta: {
                model: "gemini-3.8-flash-tts",
                voice: voice,
                textLength: cleanText.length
              },
              timestamp: new Date().toISOString()
            }
          }), {
            status: response.status,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const resData = await response.json();
        const candidate = resData.candidates?.[0];
        const inlineData = candidate?.content?.parts?.[0]?.inlineData;

        if (!inlineData?.data) {
          return new Response(JSON.stringify({
            error: "Google API 未返回有效音频数据",
            details: {
              candidateSummary: candidate ? "存在候选但无内联音频" : "无有效候选结果",
              apiFullResponse: resData,
              timestamp: new Date().toISOString()
            }
          }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 解码 Base64 WAV
        const binaryString = atob(inlineData.data);
        const len = binaryString.length;
        const wavBytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          wavBytes[i] = binaryString.charCodeAt(i);
        }

        const finalHeaders = {
          "Content-Type": "audio/wav",
          "Content-Disposition": 'attachment; filename="vocab.wav"',
          "Cache-Control": "public, max-age=604800",
          "X-Cache-Status": "MISS"
        };

        const resultResponse = new Response(wavBytes, { headers: finalHeaders });
        try {
          await cache.put(cacheUrl, new Response(wavBytes, { headers: finalHeaders }));
        } catch (_) {}

        return resultResponse;

      } catch (err) {
        return new Response(JSON.stringify({
          error: `边缘运行异常: ${err.message}`,
          details: {
            stack: err.stack,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString()
          }
        }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    // 2. 页面视图
    return new Response(buildHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

function buildFinalStyle(customStyle, speed) {
  let base = (customStyle || "").trim();
  if (!base) {
    base = "Professional Japanese tutor. Calm and educational pacing. Authentic standard Tokyo pitch accent, 1 second pause between words and Chinese translations.";
  }

  if (speed === "slow") {
    base += " Speak deliberately slow (~0.8x pace) with crisp phoneme delivery.";
  } else if (speed === "fast") {
    base += " Speak at a natural, fluid native conversational tempo (~1.15x pace).";
  }

  return base;
}

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>日语跟读助教 · Studio Pro</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #131b2e;
      --surface: #1e293b;
      --border: #334155;
      --primary: #0284c7;
      --primary-hover: #0369a1;
      --accent: #38bdf8;
      --success: #10b981;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 14px; min-height: 100vh; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 520px; display: flex; flex-direction: column; gap: 12px; }
    
    .header { display: flex; justify-content: space-between; align-items: center; }
    .title { font-size: 1.15rem; font-weight: 700; color: var(--accent); }
    .badge { font-size: 0.7rem; background: var(--surface); color: var(--text-muted); padding: 3px 8px; border-radius: 9999px; border: 1px solid var(--border); }

    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 11px; }
    
    .form-row { display: flex; gap: 8px; }
    .form-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    label { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; display: flex; justify-content: space-between; }
    
    select, input[type="text"] {
      width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border);
      border-radius: 8px; padding: 9px 10px; font-size: 0.85rem; outline: none;
    }
    select:focus, input[type="text"]:focus, textarea:focus { border-color: var(--accent); }

    .expression-bar { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 3px; scrollbar-width: none; }
    .expression-bar::-webkit-scrollbar { display: none; }
    .btn-exp {
      background: #1e293b; color: #cbd5e1; border: 1px dashed #475569;
      border-radius: 6px; padding: 4px 8px; font-size: 0.72rem; white-space: nowrap; cursor: pointer;
    }
    .btn-exp:active { background: #334155; }

    .textarea-box { position: relative; }
    textarea {
      width: 100%; height: 240px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text); padding: 12px; font-size: 0.95rem; line-height: 1.6;
      resize: vertical; outline: none; min-height: 180px;
    }
    .char-count { position: absolute; right: 10px; bottom: 8px; font-size: 0.7rem; color: #64748b; background: rgba(15,23,42,0.7); padding: 2px 6px; border-radius: 4px; }

    .btn-submit {
      background: var(--primary); color: #fff; border: none; padding: 13px;
      border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: background 0.2s;
    }
    .btn-submit:hover { background: var(--primary-hover); }
    .btn-submit:disabled { opacity: 0.55; cursor: not-allowed; }

    .player-card { display: none; flex-direction: column; gap: 10px; background: var(--surface); padding: 12px; border-radius: 8px; border: 1px solid var(--border); }
    audio { width: 100%; height: 38px; outline: none; }
    .player-actions { display: flex; gap: 8px; align-items: center; }
    .speed-group { display: flex; gap: 4px; }
    .speed-btn {
      background: var(--card-bg); border: 1px solid var(--border); color: var(--text-muted);
      font-size: 0.75rem; padding: 6px 9px; border-radius: 6px; cursor: pointer;
    }
    .speed-btn.active { color: var(--accent); border-color: var(--accent); }
    .btn-download {
      flex: 1; background: var(--success); color: #fff; text-align: center; text-decoration: none;
      padding: 8px 12px; border-radius: 6px; font-size: 0.85rem; font-weight: 600; display: block;
    }

    .preset-chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    .preset-chips::-webkit-scrollbar { display: none; }
    .chip { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 0.72rem; white-space: nowrap; cursor: pointer; }

    /* 独立报错与诊断面板 */
    .error-card {
      display: none; flex-direction: column; gap: 8px;
      background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger);
      border-radius: 10px; padding: 12px;
    }
    .error-header { display: flex; justify-content: space-between; align-items: center; color: var(--danger); font-weight: 600; font-size: 0.85rem; }
    .error-msg { font-size: 0.8rem; color: #fca5a5; line-height: 1.4; word-break: break-all; }
    .error-details {
      background: #0b0f19; border: 1px solid #334155; border-radius: 6px;
      padding: 8px; font-family: monospace; font-size: 0.7rem; color: #94a3b8;
      max-height: 180px; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
    }
    .btn-copy-error {
      background: #334155; color: #f1f5f9; border: none; padding: 4px 8px;
      border-radius: 4px; font-size: 0.72rem; cursor: pointer; align-self: flex-start;
    }

    .footer-note { font-size: 0.7rem; color: #64748b; text-align: center; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="title">日语单词跟读助教</span>
      <span class="badge">Gemini 3.8 Flash TTS</span>
    </div>

    <div class="card">
      <div class="form-row">
        <div class="form-col" style="flex: 1.2;">
          <label>发音人声 (Voice)</label>
          <select id="voiceSelect">
            <optgroup label="Tutor 教学/导师">
              <option value="Fola" selected>Fola (清晰友善·标准女声)</option>
              <option value="Bodi">Bodi (沉稳内敛·低音男声)</option>
              <option value="Lumi">Lumi (亲切温和·低音女声)</option>
              <option value="Sola">Sola (轻柔放松·高音女声)</option>
              <option value="Varo">Varo (随性自然·低音男声)</option>
              <option value="Sadaltager">Sadaltager (博学严谨·中音男声)</option>
              <option value="Sulafat">Sulafat (温润温和·中音女声)</option>
              <option value="Zephyr">Zephyr (明亮清朗·高音男声)</option>
            </optgroup>
            <optgroup label="Instructional 指令/教程">
              <option value="Kira">Kira (冷静自信·中音女声)</option>
              <option value="Ludo">Ludo (清晰果断·低音男声)</option>
              <option value="Mako">Mako (活力鲜明·低音女声)</option>
              <option value="Rina">Rina (温柔松弛·中音女声)</option>
            </optgroup>
            <optgroup label="Podcast 播客/访谈">
              <option value="Rami">Rami (温和自然·低音男声)</option>
              <option value="Brio">Brio (轻柔亲昵·中低音男声)</option>
              <option value="Jori">Jori (亲和接近·中低音女声)</option>
              <option value="Veda">Veda (热心温和·高音女声)</option>
            </optgroup>
            <optgroup label="Commercial 旁白/配音">
              <option value="Koda">Koda (直接专业·中低音男声)</option>
              <option value="Nika">Nika (热情亲切·中音女声)</option>
              <option value="Zeno">Zeno (沉稳酷飒·中高音男声)</option>
            </optgroup>
            <optgroup label="Assistant 数字助手">
              <option value="Gero">Gero (清晰友好·低音男声)</option>
              <option value="Neno">Neno (厚重磁性·低音男声)</option>
              <option value="Olin">Olin (灵动精准·低音男声)</option>
            </optgroup>
          </select>
        </div>

        <div class="form-col" style="flex: 0.8;">
          <label>语速档位</label>
          <select id="speedSelect">
            <option value="slow">慢速 (精细跟读)</option>
            <option value="normal" selected>适中 (标准教学)</option>
            <option value="fast">流利 (自然语流)</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-col" style="flex: 1;">
          <label>风格预设 (Style)</label>
          <select id="stylePresetSelect" onchange="onStylePresetChange()">
            <option value="tutor" selected>日语助教 (标准东京声调+释义停顿)</option>
            <option value="friendly">Friendly (亲切柔和·微停顿)</option>
            <option value="whisper">Whisper (耳语窃窃·轻柔微声)</option>
            <option value="narration">Narration (叙事解说·起伏跌宕)</option>
            <option value="promote">Promote (热情饱满·活力四射)</option>
            <option value="custom">✏️ 自定义 Style 指令</option>
          </select>
        </div>
      </div>

      <div class="form-col">
        <label>
          <span>Style 指令提示词</span>
          <span style="color:#64748b; font-size:0.7rem;">支持语气、情感与口音控制</span>
        </label>
        <input type="text" id="stylePromptInput" placeholder="输入发音风格指令...">
      </div>

      <div>
        <label style="margin-bottom: 5px;">快捷情绪插入 (Vocal Bursts)</label>
        <div class="expression-bar">
          <button class="btn-exp" onclick="insertTag('&lt;laugh&gt;')">+ &lt;laugh&gt; 笑声</button>
          <button class="btn-exp" onclick="insertTag('&lt;gasp&gt;')">+ &lt;gasp&gt; 惊讶吸气</button>
          <button class="btn-exp" onclick="insertTag('&lt;breath&gt;')">+ &lt;breath&gt; 叹气/呼吸</button>
          <button class="btn-exp" onclick="insertTag('&lt;cackle&gt;')">+ &lt;cackle&gt; 咯咯笑</button>
          <button class="btn-exp" onclick="insertTag('&lt;argh&gt;')">+ &lt;argh&gt; 感叹</button>
          <button class="btn-exp" onclick="insertTag('…… ')">+ 停顿(省略号)</button>
        </div>
      </div>

      <div>
        <label style="margin-bottom: 5px;">常用词汇预设</label>
        <div class="preset-chips">
          <button class="chip" onclick="loadText('time')">时间时刻</button>
          <button class="chip" onclick="loadText('basic')">基础问候</button>
          <button class="chip" onclick="loadText('verbs')">生活动词</button>
          <button class="chip" onclick="loadText('expressions')">情绪发音示例</button>
          <button class="chip" onclick="loadText('clear')">清空内容</button>
        </div>
      </div>

      <div class="textarea-box">
        <textarea id="textInput" placeholder="输入单词与释义，字数不设硬性上限..."></textarea>
        <div id="charCounter" class="char-count">0 字</div>
      </div>

      <button id="runBtn" class="btn-submit" onclick="generateAudio()">开始合成朗读</button>

      <!-- 诊断与报错详情面板 -->
      <div class="error-card" id="errorCard">
        <div class="error-header">
          <span id="errorTitle">⚠️ 合成异常</span>
          <button class="btn-copy-error" onclick="copyErrorLog()">复制诊断日志</button>
        </div>
        <div class="error-msg" id="errorMsgText"></div>
        <pre class="error-details" id="errorDetailsText"></pre>
      </div>

      <!-- 播放器区域 -->
      <div class="player-card" id="playerCard">
        <audio id="audioPlayer" controls></audio>
        <div class="player-actions">
          <div class="speed-group">
            <button class="speed-btn active" onclick="setSpeed(1.0, this)">1.0x</button>
            <button class="speed-btn" onclick="setSpeed(0.8, this)">0.8x</button>
            <button class="speed-btn" onclick="setSpeed(1.25, this)">1.2x</button>
          </div>
          <a id="downloadBtn" class="btn-download" download="vocab.wav">保存音频到手机</a>
        </div>
      </div>
    </div>

    <div class="footer-note">
      已解除字符数量限制 · 遇错自动捕获底层 Google 状态码并输出诊断日志
    </div>
  </div>

  <script>
    const STYLE_PRESETS = {
      tutor: "Professional Japanese tutor. Speak with a calm and educational tone. Authentic standard Tokyo pitch accent, 1 second pause between words and Chinese translations.",
      friendly: "Warm and neutral delivery with friendly micro-pauses. Gentle, encouraging, and supportive tone.",
      whisper: "Whisper quietly with a delicate, breathy tone. Gentle micro-pauses.",
      narration: "Commanding, rich vocal modulation with dramatic pauses and elegant educational cadence.",
      promote: "High energy, enthusiastic, clear vocal bursts and engaging tempo."
    };

    const TEXT_PRESETS = {
      time: "いま…… 现在。\\nじ…… 点。\\nふん…… 分。\\nなんじ…… 几点。\\nごぜん…… 上午。\\nごご…… 下午。",
      basic: "おはようございます…… 早上好。\\nこんにちは…… 你好。\\nこんばんは…… 晚上好。\\nありがとうございます…… 谢谢。\\nすみません…… 不好意思。",
      verbs: "おきます…… 起床。\\nねます…… 睡觉。\\nたべます…… 吃。\\nのみます…… 喝。\\nいきます…… 去。",
      expressions: "すごいですね！ <laugh> 太厉害了！\\nえっ？ <gasp> 本当ですか？ 真的吗？\\nふぅ…… <breath> 疲れました。 好累呀。"
    };

    const textarea = document.getElementById("textInput");
    const styleInput = document.getElementById("stylePromptInput");
    const charCounter = document.getElementById("charCounter");
    const player = document.getElementById("audioPlayer");
    let timer = null;
    let latestErrorData = null;

    textarea.value = TEXT_PRESETS.time;
    styleInput.value = STYLE_PRESETS.tutor;
    updateCounter();

    textarea.addEventListener("input", updateCounter);

    function updateCounter() {
      charCounter.innerText = textarea.value.length + " 字";
    }

    function onStylePresetChange() {
      const val = document.getElementById("stylePresetSelect").value;
      if (val === "custom") {
        styleInput.value = "";
        styleInput.placeholder = "例如: Speak like an anime teacher, gentle and enthusiastic.";
        styleInput.focus();
      } else {
        styleInput.value = STYLE_PRESETS[val] || "";
      }
    }

    function insertTag(tag) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;
      tex
