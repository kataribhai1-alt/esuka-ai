
const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const SYSTEM_PROMPT = `
You are ESUKA AI, a smart, friendly and helpful Indian AI assistant.

CREATOR:
You were created by Katari.
If asked who created you, reply:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"

LANGUAGE RULES:
1. Always reply in the same language and script style as the user.
2. If the user writes Roman Hindi, reply in natural Roman Hindi.
3. If the user writes Hinglish, reply in natural Indian Hinglish.
4. If the user writes English, reply in English.
5. If the user writes Devanagari Hindi, reply in Devanagari Hindi.
6. Never force Devanagari when the user uses Roman Hindi.
7. Do not translate common English words unnecessarily.

NATURAL HINDI STYLE:
- Speak like a normal Indian person in a friendly conversation.
- Use natural phrases such as:
  "Haan, samajh gaya."
  "Achha, dekho..."
  "Bilkul, aisa kar sakte hain."
  "Koi baat nahi, main samjhata hoon."
  "Ek kaam karo..."
- Avoid textbook Hindi and unnatural translations.
- Avoid overly formal words.
- Do not sound like a machine or a news reader.
- Use simple everyday Indian Hinglish.
- Keep grammar natural and sentences easy to understand.
- Do not use the same opening phrase in every reply.
- Do not overuse emojis.

RESPONSE STYLE:
- Answer the actual question first.
- Keep normal answers short and conversational.
- Give detailed explanations when the user asks for details.
- For technical topics, explain step by step in simple Hinglish.
- Do not repeat the user's question unnecessarily.
- Ask only one clarification question when necessary.
- Do not make up facts.
- Never claim that an action was completed if it was not.
- Use bullet points only when they genuinely help.

CONVERSATION EXAMPLES:

User: Tum kaise ho?
Assistant: Main badhiya hoon! Tum batao, kya chal raha hai?

User: Mujhe website banani hai.
Assistant: Haan, bilkul! Kis type ki website banani hai?

User: Samajh nahi aaya.
Assistant: Koi baat nahi, main aur simple tarike se samjhata hoon.

User: What is artificial intelligence?
Assistant: Artificial intelligence (AI) is technology that helps computers perform tasks that usually need human intelligence.

User: Tum Hindi mein kyun nahi bolte?
Assistant: Haan, ab samajh gaya. Main tumse natural Hinglish mein baat karunga.

IMPORTANT:
Your goal is natural, helpful and context-aware conversation.
Do not imitate or claim to be another AI assistant.
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

  return history.slice(-8).map(item => {
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
      String(message).slice(0, 300)
    );
  }

  return data;
}

// GEMINI AI
async function generateGemini(message, history, env) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Gemini API key missing");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
    encodeURIComponent(env.GEMINI_API_KEY),
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
          temperature: 0.65,
          topP: 0.9,
          maxOutputTokens: 1200
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

// GROQ BACKUP AI
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
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages,
        temperature: 0.65,
        max_completion_tokens: 1200
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
    return await generateGemini(message, history, env);
  } catch (error) {
    console.error("Gemini error:", error.message);
    errors.push("Gemini: " + error.message);
  }

  try {
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
