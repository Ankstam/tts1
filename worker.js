export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 处理 TTS 音频生成
    if (url.pathname === "/api/tts" && request.method === "POST") {
      try {
        const { text, voice = "Fola" } = await request.json();
        const apiKey = env.GEMINI_API_KEY;

        if (!apiKey) {
          return new Response(JSON.stringify({ error: "未检测到 GEMINI_API_KEY，请在 Worker Settings 中配置！" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: "输入的朗读内容不能为空" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }

        // 锁定教学提示词：标准东京语调 + 1秒自然停顿 + 中文释义清晰发音
        const stylePrompt =
          "Act as a professional language teacher. Speak with a clear, steady, and calm tone. " +
          "Pronounce Japanese words slowly with authentic standard Tokyo pitch accent, " +
          "pause naturally for 1 second, then pronounce the Chinese translation in a clear and standard Mandarin accent. " +
          "Keep a consistent educational pacing.";

        // 严格匹配 Gemini 3.8 Flash TTS 官方结构
        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `[Style: ${stylePrompt}]\n\n${text}`,
                  speechMetadata: {
                    speaker: "Speaker 1"
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.3,
            responseModalities: ["audio"],
            speechConfig: {
              multiSpeakerVoiceConfig: {
                mode: "VERBATIM",
                speakerVoiceConfigs: [
                  {
                    speaker: "Speaker 1",
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: voice
                      }
                    }
                  }
                ]
              }
            }
          }
        };

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent?key=${apiKey}`;
        const response = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errDetail = await response.text();
          return new Response(JSON.stringify({ error: `Google API 报错 (${response.status}): ${errDetail}` }), {
            status: response.status,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }

        const resJson = await response.json();
        const candidate = resJson.candidates?.[0];
        const inlineData = candidate?.content?.parts?.[0]?.inlineData;

        if (!inlineData?.data) {
          return new Response(JSON.stringify({ error: "未提取到音频数据，请检查文本是否合规" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }

        // 解码 Base64 PCM 并组装 44 字节标准 WAV 头部
        const binaryStr = atob(inlineData.data);
        const pcmBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          pcmBytes[i] = binaryStr.charCodeAt(i);
        }

        let sampleRate = 24000;
        if (inlineData.mimeType && inlineData.mimeType.includes("rate=")) {
          const matched = inlineData.mimeType.match(/rate=(\d+)/);
          if (matched) sampleRate = parseInt(matched[1], 10);
        }

        const wavBytes = addWavHeader(pcmBytes, sampleRate);

        return new Response(wavBytes, {
          headers: {
            "Content-Type": "audio/wav",
            "Content-Disposition": 'inline; filename="japanese_vocab.wav"',
            "Cache-Control": "no-cache",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: `Worker 异常: ${err.message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
    }

    // 2. 渲染前端网页
    return new Response(renderHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function addWavHeader(rawAudio, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = rawAudio.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer, 44).set(rawAudio);
  return buffer;
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>日语单词跟读助教</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 16px; min-height: 100vh; display: flex; justify-content: center; }
    .app { width: 100%; max-width: 520px; display: flex; flex-direction: column; gap: 14px; }
    .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 4px; }
    .title { font-size: 1.15rem; font-weight: 700; color: #38bdf8; }
    .badge { font-size: 0.75rem; background: #1e293b; color: #94a3b8; padding: 4px 8px; border-radius: 9999px; border: 1px solid #334155; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 14px; }
    .controls { display: flex; gap: 10px; margin-bottom: 10px; }
    select { flex: 1; background: #0f172a; color: #f8fafc; border: 1px solid #475569; border-radius: 8px; padding: 8px 10px; font-size: 0.9rem; outline: none; }
    .btn-clear { background: #334155; color: #cbd5e1; border: none; padding: 0 12px; border-radius: 8px; font-size: 0.85rem; cursor: pointer; }
    textarea { width: 100%; height: 260px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #f1f5f9; padding: 12px; font-size: 0.95rem; line-height: 1.6; resize: none; outline: none; font-family: inherit; }
    textarea:focus { border-color: #38bdf8; }
    .btn-run { width: 100%; background: #0284c7; color: #ffffff; border: none; padding: 13px; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; display: flex; justify-content: center; align-items: center; gap: 8px; }
    .btn-run:disabled { opacity: 0.5; cursor: not-allowed; }
    .audio-panel { display: none; flex-direction: column; gap: 10px; margin-top: 10px; }
    audio { width: 100%; height: 42px; border-radius: 8px; }
    .actions { display: flex; gap: 10px; }
    .btn-act { flex: 1; text-align: center; text-decoration: none; padding: 10px; border-radius: 8px; font-size: 0.9rem; font-weight: 500; cursor: pointer; border: none; }
    .btn-down { background: #10b981; color: #fff; }
    .tips { font-size: 0.75rem; color: #64748b; line-height: 1.4; text-align: center; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="app">
    <div class="header">
      <span class="title">日语单词跟读助教</span>
      <span class="badge">Gemini TTS</span>
    </div>

    <div class="card">
      <div class="controls">
        <select id="voiceSelect">
          <option value="Fola" selected>声音: Fola (清晰标准女声)</option>
          <option value="Rami">声音: Rami (沉稳温和男声)</option>
        </select>
        <button class="btn-clear" onclick="clearInput()">清空</button>
      </div>

      <textarea id="textInput" placeholder="输入单词与释义，例如：&#10;いま…… 现在。&#10;じ…… 点。&#10;ふん…… 分。"></textarea>

      <button id="runBtn" class="btn-run" onclick="generate()" style="margin-top: 12px;">
        <span>开始合成朗读</span>
      </button>

      <div class="audio-panel" id="audioPanel">
        <audio id="player" controls></audio>
        <div class="actions">
          <a id="downloadBtn" class="btn-act btn-down" download="vocab.wav">保存音频到手机</a>
        </div>
      </div>
    </div>

    <div class="tips">
      后台已固化标准东京重音、教学语速与 1 秒间隔停顿
    </div>
  </div>

  <script>
    document.getElementById("textInput").value = "いま…… 现在。\\nじ…… 点。\\nふん…… 分。\\nなんじ…… 几点。\\nおきます…… 起床。\\nねます…… 睡觉。";

    function clearInput() {
      document.getElementById("textInput").value = "";
      document.getElementById("textInput").focus();
    }

    async function generate() {
      const text = document.getElementById("textInput").value.trim();
      const voice = document.getElementById("voiceSelect").value;
      const runBtn = document.getElementById("runBtn");
      const audioPanel = document.getElementById("audioPanel");
      const player = document.getElementById("player");
      const downloadBtn = document.getElementById("downloadBtn");

      if (!text) {
        alert("请输入要朗读的单词！");
        return;
      }

      runBtn.disabled = true;
      runBtn.innerHTML = "正在合成音频，请稍候...";

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice })
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({ error: "请求失败，状态码: " + res.status }));
          throw new Error(errData.error || "生成失败");
        }

        const blob = await res.blob();
        const audioUrl = URL.createObjectURL(blob);

        player.src = audioUrl;
        downloadBtn.href = audioUrl;

        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        downloadBtn.download = "japanese_vocab_" + dateStr + ".wav";

        audioPanel.style.display = "flex";
        player.play().catch(() => {});
      } catch (e) {
        alert("合成失败提示: " + e.message);
      } finally {
        runBtn.disabled = false;
        runBtn.innerHTML = "开始合成朗读";
      }
    }
  </script>
</body>
</html>`;
}
