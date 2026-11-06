const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const SYSTEM_PROMPT = `
You are ESUKA AI, a helpful and intelligent AI assistant.

CREATOR:
You were created by Katari.
If asked who created you, reply:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"

LANGUAGE:
- Reply in natural Indian conversational language.
- If user writes Roman Hindi, reply in Roman Hindi.
- If user writes English, reply in English.
- Use natural Hinglish.
- Avoid formal Hindi and unnecessary Devanagari.
- Keep answers clear, friendly and useful.
- Do not repeat sentences unnecessarily.

BEHAVIOUR:
- Help with general questions, coding, learning and creativity.
- Never claim an action was completed if it was not.
`;

function getCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin":
      ALLOWED_ORIGINS.includes(origin) ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors
    }
  });
}

function getHistory(history) {
  if (!Array.isArray(history)) return [];

  return history.slice(-12).map(item => {
    const role =
      item.role === "assistant" || item.role === "model"
        ? "model"
        : "user";

    const content =
      item.content || item.text || item.message || "";

    return {
      role,
      parts: [{ text: String(content) }]
    };
  }).filter(item => item.parts[0].text.trim());
}

async function parseResponse(response) {
  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Invalid provider response. HTTP " + response.status);
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      "Provider request failed";

    throw new Error(
      "HTTP " + response.status + ": " +
      String(message).slice(0, 300)
    );
  }

  return data;
}

// GEMINI AI - UPDATED MODEL
async function generateGemini(message, history, env) {
  const key = env.GEMINI_API_KEY;

  if (!key) throw new Error("Gemini API key missing");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
    encodeURIComponent(key),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [
          ...getHistory(history),
          {
            role: "user",
            parts: [{ text: message }]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          thinkingConfig: {
            thinkingLevel: "LOW"
          }
        }
      })
    }
  );

  const data = await parseResponse(response);

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!reply) {
    throw new Error(
      "Gemini returned no text: " +
      (data.promptFeedback?.blockReason || "Unknown reason")
    );
  }

  return reply;
}

// GROQ AI - UPDATED MODEL
async function generateGroq(message, history, env) {
  const key = env.GROQ_API_KEY;

  if (!key) throw new Error("Groq API key missing");

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },
    ...getHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.parts.map(part => part.text).join("\n")
    })),
    {
      role: "user",
      content: message
    }
  ];

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages,
        max_completion_tokens: 2048
      })
    }
  );

  const data = await parseResponse(response);

  const reply = data.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    throw new Error("Groq returned an empty response");
  }

  return reply;
}

// AUTOMATIC AI FALLBACK
async function generateChat(message, history, env) {
  const errors = [];

  try {
    if (!env.GEMINI_API_KEY) {
      throw new Error("Gemini key missing");
    }

    return await generateGemini(message, history, env);

  } catch (error) {
    console.error("Gemini error:", error.message);
    errors.push("Gemini: " + error.message);
  }

  try {
    if (!env.GROQ_API_KEY) {
      throw new Error("Groq key missing");
    }

    return await generateGroq(message, history, env);

  } catch (error) {
    console.error("Groq error:", error.message);
    errors.push("Groq: " + error.message);
  }

  throw new Error(errors.join(" | ").slice(0, 700));
}

// IMAGE GENERATION
function toBase64(bytes) {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 8192)
    );
  }

  return btoa(binary);
}

async function generateImage(prompt, env) {
  if (!env.AI) {
    throw new Error("Cloudflare AI binding missing");
  }

  if (!prompt || !String(prompt).trim()) {
    throw new Error("Image prompt is required");
  }

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-1-schnell",
    {
      prompt: String(prompt).trim(),
      steps: 8
    }
  );

  if (result?.image) {
    return "data:image/png;base64," + result.image;
  }

  if (result instanceof ReadableStream) {
    const buffer = await new Response(result).arrayBuffer();

    return "data:image/png;base64," +
      toBase64(new Uint8Array(buffer));
  }

  throw new Error("Image generation returned no image");
}

// MAIN WORKER
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.includes(origin)) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    // HEALTH CHECK
    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return json({
        success: true,
        name: "ESUKA AI",
        status: "Backend is running",
        models: {
          gemini: "gemini-3.8-flash",
          groq: "openai/gpt-oss-120b"
        },
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        groqConfigured: Boolean(env.GROQ_API_KEY),
        imageConfigured: Boolean(env.AI)
      }, 200, cors);
    }

    // FRONTEND
    if (request.method === "GET") {
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({
        success: false,
        error: "Assets binding missing"
      }, 500, cors);
    }

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "Method not allowed"
      }, 405, cors);
    }

    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({
        success: false,
        error: "Origin not allowed"
      }, 403, cors);
    }

    try {
      const body = await request.json();

      // IMAGE MODE
      if (body.mode === "image") {
        const image = await generateImage(
          body.prompt || body.message,
          env
        );

        return json({
          success: true,
          image
        }, 200, cors);
      }

      // CHAT MODE
      const message = String(body.message || "").trim();

      if (!message) {
        return json({
          success: false,
          error: "Message is required"
        }, 400, cors);
      }

      const reply = await generateChat(
        message,
        body.history || [],
        env
      );

      return json({
        success: true,
        reply
      }, 200, cors);

    } catch (error) {
      console.error("ESUKA AI ERROR:", error.message);

      return json({
        success: false,
        error: String(error.message || "Unknown server error")
      }, 500, cors);
    }
  }
};
