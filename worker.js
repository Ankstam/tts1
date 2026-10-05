export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 处理 TTS 音频请求
    if (url.pathname === "/api/tts" && request.method === "POST") {
      try {
        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "未设置环境变量 GEMINI_API_KEY" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const { text, voice = "Fola" } = await request.json();
        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: "朗读文本不能为空" }), {
            status: 400,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 严格锁定的专业日语教学提示词
        const styleInstruction = 
          "Act as a professional language teacher. Speak with a clear, steady, and calm tone. " +
          "Pronounce Japanese words slowly with authentic standard Tokyo pitch accent, " +
          "pause naturally for 1 second, then pronounce the Chinese translation in a clear and standard Mandarin accent. " +
          "Keep a consistent educational pacing.";

        // 对齐 Google Gemini 3.8 Flash TTS 官方规范
        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `[Style: ${styleInstruction}]\n\n${text}`,
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

        const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent?key=${apiKey}`;
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errDetail = await response.text();
          return new Response(JSON.stringify({ error: `Google API 错误 (${response.status}): ${errDetail}` }), {
            status: response.status,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        const resData = await response.json();
        const candidate = resData.candidates?.[0];
        const inlineData = candidate?.content?.parts?.[0]?.inlineData;

        if (!inlineData?.data) {
          return new Response(JSON.stringify({ error: "未能生成音频数据，请缩短文本或检查内容" }), {
            status: 500,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }

        // 解码 Base64 PCM 裸流
        const binaryString = atob(inlineData.data);
        const pcmLength = binaryString.length;
        const pcmBytes = new Uint8Array(pcmLength);
        for (let i = 0; i < pcmLength; i++) {
          pcmBytes[i] = binaryString.charCodeAt(i);
        }

        // 解析采样率
        let sampleRate = 24000;
        if (inlineData.mimeType && inlineData.mimeType.includes("rate=")) {
          const match = inlineData.mimeType.match(/rate=(\d+)/);
          if (match) sampleRate = parseInt(match[1], 10);
        }

        // 打包标准 WAV 44 字节头
        const wavBuffer = buildWav(pcmBytes, sampleRate);

        return new Response(wavBuffer, {
          headers: {
            "Content-Type": "audio/wav",
            "Content-Disposition": 'attachment; filename="vocab.wav"',
            "Cache-Control": "no-cache"
          }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: `服务端异常: ${err.message}` }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    // 2. 访问首页时渲染手机端专用前端界面
    return new Response(buildHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// 构造 44 字节标准 RIFF WAV 头部
function buildWav(pcmData, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
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

  new Uint8Array(buffer, 44).set(pcmData);
  return buffer;
}

// 简约、无任何冗余组件的移动端界面
function buildHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>日语单词朗诵助教</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #f1f5f9; padding: 16px; min-height: 100vh; display: flex; justify-content: center; }
    .box { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 14px; }
    .title-row { display: flex; justify-content: space-between; align-items: center; }
    .title { font-size: 1.15rem; font-weight: 700; color: #38bdf8; }
    .tag { font-size: 0.75rem; background: #1e293b; color: #94a3b8; padding: 3px 8px; border-radius: 6px; }
    .bar { display: flex; gap: 10px; }
    select { flex: 1; background: #1e293b; color: #f8fafc; border: 1px solid #334155; border-radius: 8px; padding: 10px; font-size: 0.9rem; outline: none; }
    .btn-clear { background: #334155; color: #cbd5e1; border: none; padding: 0 14px; border-radius: 8px; cursor: pointer; }
    textarea { width: 100%; height: 300px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #f8fafc; padding: 12px; font-size: 0.95rem; line-height: 1.6; resize: none; outline: none; }
    textarea:focus { border-color: #38bdf8; }
    .btn-run { background: #0284c7; color: #fff; border: none; padding: 14px; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; width: 100%; }
    .btn-run:disabled { opacity: 0.5; }
    .audio-card { display: none; flex-direction: column; gap: 10px; background: #1e293b; padding: 12px; border-radius: 8px; }
    audio { width: 100%; }
    .btn-save { background: #10b981; color: #fff; text-align: center; text-decoration: none; padding: 10px; border-radius: 6px; font-weight: 600; font-size: 0.9rem; display: block; }
    .notice { font-size: 0.75rem; color: #64748b; text-align: center; line-height: 1.4; }
  </style>
</head>
<body>
  <div class="box">
    <div class="title-row">
      <span class="title">日语单词跟读助教</span>
      <span class="tag">Gemini TTS</span>
    </div>

    <div class="bar">
      <select id="voiceSelect">
        <option value="Fola" selected>声音: Fola (清晰标准女声)</option>
        <option value="Rami">声音: Rami (温和沉稳男声)</option>
      </select>
      <button class="btn-clear" onclick="clearText()">清空</button>
    </div>

    <textarea id="textInput" placeholder="输入单词与释义，例如：&#10;いま…… 现在。&#10;じ…… 点。&#10;ふん…… 分。"></textarea>

    <button id="runBtn" class="btn-run" onclick="send()">开始合成朗读</button>

    <div class="audio-card" id="audioCard">
      <audio id="player" controls></audio>
      <a id="downloadBtn" class="btn-save" download="lesson_vocab.wav">保存音频到手机</a>
    </div>

    <div class="notice">
      后台已固化东京声调、1秒停顿及教学语速，直接输入词汇即可
    </div>
  </div>

  <script>
    document.getElementById("textInput").value = "いま…… 现在。\\nじ…… 点。\\nふん…… 分。\\nなんじ…… 几点。\\nおきます…… 起床。\\nねます…… 睡觉。";

    function clearText() {
      document.getElementById("textInput").value = "";
      document.getElementById("textInput").focus();
    }

    async function send() {
      const text = document.getElementById("textInput").value.trim();
      const voice = document.getElementById("voiceSelect").value;
      const btn = document.getElementById("runBtn");
      const card = document.getElementById("audioCard");
      const player = document.getElementById("player");
      const dl = document.getElementById("downloadBtn");

      if (!text) {
        alert("请输入单词！");
        return;
      }

      btn.disabled = true;
      btn.innerText = "正在合成音频，请稍候...";

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voice })
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "网络请求异常" }));
          throw new Error(err.error || "生成失败");
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        player.src = url;
        dl.href = url;
        const now = new Date();
        const timeTag = now.toISOString().slice(0, 10).replace(/-/g, "") + "_" + now.getHours() + now.getMinutes();
        dl.download = "japanese_vocab_" + timeTag + ".wav";

        card.style.display = "flex";
        player.play().catch(() => {});
      } catch (e) {
        alert("错误: " + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = "开始合成朗读";
      }
    }
  </script>
</body>
</html>`;
}
