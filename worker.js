
const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const SYSTEM_PROMPT = `
You are ESUKA AI, a helpful and intelligent AI assistant.

CREATOR:
You were created by Katari.
If someone asks who created you, say:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"

LANGUAGE:
- Reply in natural Indian conversational language.
- If user writes Roman Hindi, reply in Roman Hindi.
- If user writes English, reply in English.
- Use casual Hinglish naturally.
- Avoid formal Hindi and unnecessary Devanagari.
- Keep answers clear, friendly and helpful.
- Do not repeat sentences unnecessarily.

BEHAVIOUR:
- Help with general questions, coding, learning and creativity.
- Never pretend to have performed an action you have not performed.
`;

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);

  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...cors
    }
  });
}

function getHistoryText(history) {
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

async function readProviderResponse(response) {
  const raw = await response.text();

  let data = {};

  try {
    data = JSON.parse(raw);
  } catch {
    data = {};
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      "Provider returned an error";

    throw new Error(
      "HTTP " + response.status + ": " + String(message).slice(0, 400)
    );
  }

  return data;
}

// GEMINI AI
async function generateGemini(message, history, env) {
  const key = env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const contents = [
    ...getHistoryText(history),
    {
      role: "user",
      parts: [{ text: message }]
    }
  ];

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
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
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048
        }
      })
    }
  );

  const data = await readProviderResponse(response);

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!reply) {
    const reason =
      data.promptFeedback?.blockReason ||
      data.candidates?.[0]?.finishReason ||
      "No text returned";

    throw new Error("Gemini returned no reply: " + reason);
  }

  return reply;
}

// GROQ BACKUP AI
async function generateGroq(message, history, env) {
  const key = env.GROQ_API_KEY;

  if (!key) {
    throw new Error("GROQ_API_KEY is missing");
  }

  const messages = [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },

    ...getHistoryText(history).map(item => ({
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
        model: "llama-3.3-70b-versatile",
        messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    }
  );

  const data = await readProviderResponse(response);

  const reply = data.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    throw new Error("Groq returned an empty response");
  }

  return reply;
}

// CHAT SYSTEM WITH AUTOMATIC FALLBACK
async function generateChat(message, history, env) {
  const errors = [];

  if (env.GEMINI_API_KEY) {
    try {
      return await generateGemini(message, history, env);
    } catch (error) {
      console.error("Gemini failed:", error.message);
      errors.push("Gemini: " + error.message);
    }
  } else {
    errors.push("Gemini API key missing");
  }

  if (env.GROQ_API_KEY) {
    try {
      return await generateGroq(message, history, env);
    } catch (error) {
      console.error("Groq failed:", error.message);
      errors.push("Groq: " + error.message);
    }
  } else {
    errors.push("Groq API key missing");
  }

  throw new Error(errors.join(" | "));
}

// IMAGE GENERATION
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

async function generateImage(prompt, env) {
  if (!env.AI) {
    throw new Error("Cloudflare AI binding is missing");
  }

  if (!prompt || !String(prompt).trim()) {
    throw new Error("Image prompt is empty");
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
      bytesToBase64(new Uint8Array(buffer));
  }

  throw new Error("Image provider returned no image");
}

// MAIN WORKER
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);
    const url = new URL(request.url);

    // CORS PREFLIGHT
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
        modes: ["chat", "image"],
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
        error: "Website assets are not configured"
      }, 404, cors);
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
        error: error.message || "Unknown server error"
      }, 500, cors);
    }
  }
};
