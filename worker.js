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

        // 将长省略号规整为标点逗号，防止 TTS 模型出现异常长停顿或截断
        const cleanText = text.replace(/……/g, "，");

        // 教学风格指令直接放入独立的元数据字段，不污染朗读文本
        const styleInstruction = 
          "Professional language teacher. Clear, steady, and calm tone. " +
          "Pronounce Japanese words slowly with authentic standard Tokyo pitch accent, " +
          "pause for 1 second, then pronounce the Chinese translation in clear standard Mandarin.";

        // 对齐 Gemini 3.8 Flash TTS 官方单说话人标准接口
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
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errDetail = await response.text();
          return new Response(JSON.stringify({ error: `Google API 报错 (${response.status}): ${errDetail}` }), {
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

        // Gemini 3.8 Flash TTS 返回的数据本身已是完整 WAV 文件，直接解码下发即可，绝不能再次添加 WAV 头
        const binaryString = atob(inlineData.data);
        const len = binaryString.length;
        const wavBytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          wavBytes[i] = binaryString.charCodeAt(i);
        }

        return new Response(wavBytes, {
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

    // 2. 访问首页时渲染前端界面
    return new Response(buildHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

// 移动端全屏前端界面
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
    textarea { width: 100%; height: 280px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #f8fafc; padding: 12px; font-size: 0.95rem; line-height: 1.6; resize: none; outline: none; }
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
      <span class="tag">Gemini 3.8 Flash TTS</span>
    </div>

    <div class="bar">
      <select id="voiceSelect">
        <option value="Fola" selected>声音: Fola (清晰标准女声)</option>
        <option value="Rami">声音: Rami (温和沉稳男声)</option>
        <option value="Lumi">声音: Lumi (亲切自然女声)</option>
        <option value="Bodi">声音: Bodi (低沉柔和男声)</option>
        <option value="Koda">声音: Koda (专业解说男声)</option>
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
        alert("合成失败提示: " + e.message);
      } finally {
        btn.disabled = false;
        btn.innerText = "开始合成朗读";
      }
    }
  </script>
</body>
</html>`;
}
