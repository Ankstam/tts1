export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. TTS 核心合成接口
    if (url.pathname === "/api/tts" && request.method === "POST") {
      try {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "环境变量 GEMINI_API_KEY 未正确配置" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const body = await request.json().catch(() => ({}));
        const {
          text,
          voice = "Fola",
          mode = "teaching",
          speed = "normal"
        } = body;

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: "输入文本不能为空" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 字符数限制保护，防止超出超时或模型上限
        if (text.length > 2500) {
          return new Response(JSON.stringify({ error: "单次输入文本过长，请控制在 2500 字以内" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 规范化标点符号，防止 TTS 模型遇到多重省略号异常截断
        const cleanText = text
          .replace(/[…]{2,}/g, "，")
          .replace(/…/g, "，")
          .replace(/(\r\n|\n|\r)+/g, "\n")
          .trim();

        // 构造边缘缓存 Key
        const cachePayload = `${cleanText}_${voice}_${mode}_${speed}`;
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

        // 根据模式与语速组装教学元数据指令
        const styleInstruction = buildInstruction(mode, speed);

        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: cleanText,
                  speechMetadata: {
                    style: styleInstruction
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
        const apiResponse = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!apiResponse.ok) {
          const errDetail = await apiResponse.text();
          let parsedMsg = errDetail;
          try {
            const j = JSON.parse(errDetail);
            parsedMsg = j.error?.message || errDetail;
          } catch (_) {}
          return new Response(JSON.stringify({ error: `Google API (${apiResponse.status}): ${parsedMsg}` }), {
            status: apiResponse.status,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const resData = await apiResponse.json();
        const candidate = resData.candidates?.[0];
        const inlineData = candidate?.content?.parts?.[0]?.inlineData;

        if (!inlineData?.data) {
          return new Response(JSON.stringify({ error: "模型未返回音频数据，请调整输入内容重试" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 解码 Base64 音频数据
        const binaryString = atob(inlineData.data);
        const len = binaryString.length;
        const wavBytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          wavBytes[i] = binaryString.charCodeAt(i);
        }

        // 封装响应与缓存响应（缓存 7 天）
        const finalHeaders = {
          "Content-Type": "audio/wav",
          "Content-Disposition": 'attachment; filename="vocab.wav"',
          "Cache-Control": "public, max-age=604800",
          "X-Cache-Status": "MISS"
        };

        const responseToReturn = new Response(wavBytes, { headers: finalHeaders });
        try {
          await cache.put(cacheUrl, new Response(wavBytes, { headers: finalHeaders }));
        } catch (_) {}

        return responseToReturn;

      } catch (err) {
        return new Response(JSON.stringify({ error: `边缘服务异常: ${err.message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    // 2. 页面主视图渲染
    return new Response(buildHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// 构造教学指令
function buildInstruction(mode, speed) {
  let speedPrompt = "Clear, steady, and educational pacing.";
  if (speed === "slow") {
    speedPrompt = "Speak deliberately slow (~0.8x speed) to allow learners to hear every phoneme clearly.";
  } else if (speed === "fast") {
    speedPrompt = "Speak at a natural, fluid native conversational tempo (~1.1x speed).";
  }

  let modePrompt = "";
  switch (mode) {
    case "repetition":
      modePrompt = 
        "Act as a Japanese language coach. For each entry, pronounce the Japanese word with precise standard Tokyo pitch accent, " +
        "pause for 1.2 seconds, pronounce the Japanese word a second time, pause for 0.8 seconds, then pronounce the Chinese explanation.";
      break;
    case "jp_only":
      modePrompt = 
        "Act as a native Japanese tutor. Pronounce ONLY the Japanese words with standard Tokyo pitch accent. " +
        "Skip all Chinese characters and explanations completely. Keep a distinct 1.5-second silence between each vocabulary entry.";
      break;
    case "teaching":
    default:
      modePrompt = 
        "Act as a professional language teacher. Speak with a calm and supportive tone. " +
        "Pronounce Japanese words slowly with authentic standard Tokyo pitch accent, " +
        "pause naturally for 1 second, then pronounce the Chinese explanation in clear standard Mandarin.";
      break;
  }

  return `${modePrompt} ${speedPrompt}`;
}

// 移动端/桌面端通用现代化界面
function buildHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>日语听读跟读助教</title>
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
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 16px; min-height: 100vh; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 520px; display: flex; flex-direction: column; gap: 14px; }
    
    .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 4px; }
    .title { font-size: 1.2rem; font-weight: 700; color: var(--accent); letter-spacing: 0.5px; }
    .badge { font-size: 0.72rem; background: var(--surface); color: var(--text-muted); padding: 3px 8px; border-radius: 9999px; border: 1px solid var(--border); }

    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
    
    .row { display: flex; gap: 8px; }
    .col { flex: 1; display: flex; flex-direction: column; gap: 4px; }
    label { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; }
    select { width: 100%; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; font-size: 0.85rem; outline: none; }
    select:focus { border-color: var(--accent); }

    .preset-box { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
    .preset-box::-webkit-scrollbar { display: none; }
    .btn-chip { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; font-size: 0.75rem; white-space: nowrap; cursor: pointer; }
    .btn-chip:hover { color: var(--text); border-color: var(--accent); }

    .textarea-wrapper { position: relative; }
    textarea { width: 100%; height: 240px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 12px; font-size: 0.95rem; line-height: 1.6; resize: none; outline: none; }
    textarea:focus { border-color: var(--accent); }
    .char-count { position: absolute; right: 10px; bottom: 8px; font-size: 0.7rem; color: #64748b; }

    .btn-main { background: var(--primary); color: #fff; border: none; padding: 14px; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: background 0.2s; width: 100%; }
    .btn-main:hover { background: var(--primary-hover); }
    .btn-main:disabled { opacity: 0.55; cursor: not-allowed; }

    .audio-player-box { display: none; flex-direction: column; gap: 10px; background: var(--surface); padding: 12px; border-radius: 8px; border: 1px solid var(--border); }
    audio { width: 100%; height: 38px; outline: none; }
    
    .player-actions { display: flex; gap: 8px; align-items: center; }
    .speed-btn-group { display: flex; gap: 4px; }
    .speed-btn { background: var(--card-bg); border: 1px solid var(--border); color: var(--text-muted); font-size: 0.75rem; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
    .speed-btn.active { color: var(--accent); border-color: var(--accent); }
    .btn-download { flex: 1; background: var(--success); color: #fff; text-align: center; text-decoration: none; padding: 8px 12px; border-radius: 6px; font-size: 0.85rem; font-weight: 600; display: block; }

    .history-card { display: flex; flex-direction: column; gap: 8px; }
    .history-header { display: flex; justify-content: space-between; align-items: center; }
    .history-list { display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow-y: auto; }
    .history-item { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font-size: 0.8rem; display: flex; justify-content: space-between; align-items: center; }
    .history-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 65%; color: var(--text-muted); }
    .history-btn { background: transparent; border: none; color: var(--accent); font-size: 0.78rem; cursor: pointer; margin-left: 6px; }

    .footer-note { font-size: 0.72rem; color: #64748b; text-align: center; line-height: 1.4; padding-top: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="title">日语单词跟读助教</span>
      <span class="badge">Gemini 3.8 Flash · Edge</span>
    </div>

    <div class="card">
      <div class="row">
        <div class="col">
          <label>发音人声</label>
          <select id="voiceSelect">
            <option value="Fola" selected>Fola (标准女声)</option>
            <option value="Rami">Rami (温和男声)</option>
            <option value="Lumi">Lumi (亲切女声)</option>
            <option value="Bodi">Bodi (沉稳男声)</option>
            <option value="Koda">Koda (播音男声)</option>
          </select>
        </div>
        <div class="col">
          <label>教学模式</label>
          <select id="modeSelect">
            <option value="teaching" selected>标准助教 (日文+停顿+中文)</option>
            <option value="repetition">回声跟读 (日文+重复+释义)</option>
            <option value="jp_only">纯日文 (跳过中文释义)</option>
          </select>
        </div>
        <div class="col">
          <label>语速档位</label>
          <select id="speedSelect">
            <option value="slow">慢速 (教学)</option>
            <option value="normal" selected>适中 (标准)</option>
            <option value="fast">流利 (自然)</option>
          </select>
        </div>
      </div>

      <div>
        <label style="margin-bottom: 6px; display: block;">常用分类模板</label>
        <div class="preset-box">
          <button class="btn-chip" onclick="applyPreset('basic')">日常基础问候</button>
          <button class="btn-chip" onclick="applyPreset('time')">时间与时刻</button>
          <button class="btn-chip" onclick="applyPreset('verbs')">基础生活动词</button>
          <button class="btn-chip" onclick="applyPreset('clear')">清空内容</button>
        </div>
      </div>

      <div class="textarea-wrapper">
        <textarea id="textInput" placeholder="输入词汇与释义，一行一组..."></textarea>
        <div id="charCounter" class="char-count">0 / 2500</div>
      </div>

      <button id="runBtn" class="btn-main" onclick="startGenerate()">开始合成朗读</button>

      <div class="audio-player-box" id="audioPlayerBox">
        <audio id="audioPlayer" controls></audio>
        <div class="player-actions">
          <div class="speed-btn-group">
            <button class="speed-btn active" onclick="setPlaybackSpeed(1.0, this)">1.0x</button>
            <button class="speed-btn" onclick="setPlaybackSpeed(0.8, this)">0.8x</button>
            <button class="speed-btn" onclick="setPlaybackSpeed(1.25, this)">1.2x</button>
          </div>
          <a id="downloadLink" class="btn-download" download="japanese_lesson.wav">保存音频到本地</a>
        </div>
      </div>
    </div>

    <div class="card history-card" id="historyCard" style="display: none;">
      <div class="history-header">
        <label>最近生成历史</label>
        <button class="history-btn" onclick="clearHistory()">清空</button>
      </div>
      <div class="history-list" id="historyList"></div>
    </div>

    <div class="footer-note">
      内置东京声调固化、自适应停顿与边缘智能缓存，相同内容二次合成零延迟返回。
    </div>
  </div>

  <script>
    const PRESETS = {
      basic: "おはようございます…… 早上好。\\nこんにちは…… 你好。\\nこんばんは…… 晚上好。\\nありがとうございます…… 谢谢。\\nすみません…… 不好意思。\\nさようなら…… 再见。",
      time: "いま…… 现在。\\nじ…… 点。\\nふん…… 分。\\nなんじ…… 几点。\\nごぜん…… 上午。\\nごご…… 下午。",
      verbs: "おきます…… 起床。\\nねます…… 睡觉。\\nたべます…… 吃。\\nのみます…… 喝。\\nいきます…… 去。\\nきます…… 来。"
    };

    const textarea = document.getElementById("textInput");
    const charCounter = document.getElementById("charCounter");
    const player = document.getElementById("audioPlayer");
    let timerInterval = null;

    // 默认加载示例词汇
    textarea.value = PRESETS.time;
    updateCounter();

    textarea.addEventListener("input", updateCounter);

    function updateCounter() {
      const len = textarea.value.length;
      charCounter.innerText = len + " / 2500";
    }

    function applyPreset(key) {
      if (key === "clear") {
        textarea.value = "";
      } else {
        textarea.value = PRESETS[key] || "";
      }
      updateCounter();
      textarea.focus();
    }

    function setPlaybackSpeed(rate, btn) {
      player.playbackRate = rate;
      document.querySelectorAll(".speed-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    }

    async function startGenerate() {
      const text = textarea.value.trim();
      const voice = document.getElementById("voiceSelect").value;
      const mode = document.getElementById("modeSelect").value;
      const speed = document.getElementById("speedSelect").value;
      const btn = document.getElementById("runBtn");
      const box = document.getElementById("audioPlayerBox");
      const dl = document.getElementById("downloadLink");

      if (!text) {
        alert("请输入待朗读的单词内容！");
        return;
      }

      btn.disabled = true;
      let seconds = 0;
      btn.innerText = "正在合成音频 (0s)...";
      timerInterval = setInterval(() => {
        seconds++;
        btn.innerText = "正在合成音频 (" + seconds + "s)...";
      }, 1000);

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice, mode, speed })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "网络传输错误" }));
          throw new Error(err.error || "生成失败");
        }

        const isHit = res.headers.get("X-Cache-Status") === "HIT";
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);

        player.src = blobUrl;
        dl.href = blobUrl;
        const now = new Date();
        const timeTag = now.toISOString().slice(0, 10).replace(/-/g, "") + "_" + now.getHours() + now.getMinutes();
        dl.download = "japanese_vocab_" + timeTag + ".wav";

        box.style.display = "flex";
        player.play().catch(() => {});

        saveHistory(text.slice(0, 30), blobUrl, isHit);

      } catch (err) {
        alert("合成失败提示: " + err.message);
      } finally {
        clearInterval(timerInterval);
        btn.disabled = false;
        btn.innerText = "开始合成朗读";
      }
    }

    function saveHistory(summary, url, isHit) {
      let history = JSON.parse(localStorage.getItem("tts_history") || "[]");
      history.unshift({ summary, time: new Date().toLocaleTimeString(), isHit });
      if (history.length > 5) history.pop();
      localStorage.setItem("tts_history", JSON.stringify(history));
      renderHistory();
    }

    function renderHistory() {
      const history = JSON.parse(localStorage.getItem("tts_history") || "[]");
      const card = document.getElementById("historyCard");
      const list = document.getElementById("historyList");
      if (history.length === 0) {
        card.style.display = "none";
        return;
      }
      card.style.display = "flex";
      list.innerHTML = history.map(item => \`
        <div class="history-item">
          <span class="history-text">\${item.summary}...</span>
          <div>
            <span style="font-size:0.7rem; color:\${item.isHit ? '#10b981' : '#64748b'}">\${item.isHit ? '缓存' : '生成'} · \${item.time}</span>
          </div>
        </div>
      \`).join("");
    }

    function clearHistory() {
      localStorage.removeItem("tts_history");
      renderHistory();
    }

    // 页面加载时恢复历史记录列表
    renderHistory();
  </script>
</body>
</html>`;
}
