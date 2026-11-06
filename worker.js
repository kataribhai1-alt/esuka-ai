const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const GROQ_MODEL = "openai/gpt-oss-20b";
const GEMINI_MODEL = "gemini-3.8-flash";

const SYSTEM_PROMPT = `
You are ESUKA AI, a smart, friendly and helpful Indian AI assistant.

CREATOR:
You were created by Katari.
If asked who created you, reply:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"

LANGUAGE:
- Reply in the same language and script as the user.
- Roman Hindi input = natural Roman Hindi reply.
- Hinglish input = natural Indian Hinglish.
- English input = English.
- Devanagari Hindi input = Devanagari Hindi.
- Never force Devanagari when the user writes Roman Hindi.
- Do not unnecessarily translate common English words.

STYLE:
- Sound like a normal, friendly Indian person.
- Use simple, natural everyday language.
- Avoid textbook Hindi and overly formal words.
- Do not repeat the same opening phrase.
- Do not overuse emojis.
- Answer the actual question first.
- Keep normal replies short and conversational.
- Give details when asked.
- For technical help, explain in simple steps.
- Ask only one clarification question when needed.
- Never make up facts or claim an action was completed when it was not.
- Do not imitate or claim to be another AI assistant.

Your goal is natural, helpful and context-aware conversation.
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

  return history.slice(-6).map(item => {
    const role =
      item.role === "assistant" || item.role === "model"
        ? "model"
        : "user";

    const content =
      item.content || item.text || item.message || "";

    return {
      role,
      parts: [{
        text: String(content).slice(0, 3000)
      }]
    };
  }).filter(item => item.parts[0].text.trim());
}

async function parseResponse(response) {
  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid provider response. HTTP " + response.status
    );
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      "Provider request failed";

    throw new Error(
      "HTTP " + response.status + ": " +
      String(message).slice(0, 250)
    );
  }

  return data;
}

// FAST PRIMARY: GROQ
async function generateGroq(message, history, env) {
  if (!env.GROQ_API_KEY) {
    throw new Error("Groq API key missing");
  }

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
        "Authorization": "Bearer " + env.GROQ_API_KEY
      },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_completion_tokens: 700
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

// BACKUP: GEMINI
async function generateGemini(message, history, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Gemini API key missing");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    GEMINI_MODEL +
    ":generateContent?key=" +
    encodeURIComponent(env.GEMINI_API_KEY),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(25000),
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
          temperature: 0.65,
          maxOutputTokens: 700
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

// GROQ FIRST, GEMINI BACKUP
async function generateChat(message, history, env) {
  try {
    return await generateGroq(message, history, env);
  } catch (error) {
    console.error("Groq error:", error.message);
  }

  try {
    return await generateGemini(message, history, env);
  } catch (error) {
    console.error("Gemini error:", error.message);
    throw new Error(
      "Both AI providers failed. " +
      String(error.message).slice(0, 400)
    );
  }
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
        primaryModel: GROQ_MODEL,
        backupModel: GEMINI_MODEL,
        groqConfigured: Boolean(env.GROQ_API_KEY),
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        imageConfigured: Boolean(env.AI)
      }, 200, cors);
    }

    // WEBSITE
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
