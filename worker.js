
const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const SYSTEM_PROMPT = `
You are ESUKA AI, a smart and helpful AI assistant.

IDENTITY:
Your name is ESUKA AI.
You were created by Katari.
If someone asks who created you, say:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"
Never claim to be ChatGPT or another AI.

LANGUAGE:
- Speak natural Indian Hinglish.
- When users write Roman Hindi, reply in Roman Hindi.
- Do not automatically use Devanagari.
- Use simple everyday Indian language.
- If users write English, reply in English.
- Understand casual spelling and typos.
- Sound natural, friendly and intelligent.
- Avoid robotic and repetitive responses.

CAPABILITIES:
- General knowledge and explanations.
- Coding and website development.
- App development and debugging.
- Writing and creative ideas.
- Learning and step-by-step guidance.
- Image prompt assistance.
- Be honest about limitations.
- Never claim to have completed an action you did not perform.

Keep answers useful, clear and conversational.
`;

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);

  return {
    ...(allowed ? {
      "Access-Control-Allow-Origin": origin
    } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function generateChat(message, history, env) {
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(item =>
      item &&
      ["user", "assistant", "model"].includes(item.role) &&
      typeof (item.content || item.text) === "string"
    )
    .slice(-12)
    .map(item => ({
      role: item.role === "assistant" || item.role === "model"
        ? "model"
        : "user",
      parts: [{
        text: String(item.content || item.text).slice(0, 4000)
      }]
    }));

  const contents = [
    ...safeHistory,
    {
      role: "user",
      parts: [{ text: message }]
    }
  ];

  // GEMINI PRIMARY
  if (env.GEMINI_API_KEY) {
    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
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
            contents,
            generationConfig: {
              temperature: 0.8,
              maxOutputTokens: 2048
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error("Gemini failed");
      }

      const data = await response.json();

      const reply = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

      if (reply) return reply;

      throw new Error("Empty Gemini response");

    } catch (error) {
      // Continue to Groq backup
    }
  }

  // GROQ BACKUP
  if (env.GROQ_API_KEY) {
    try {
      const messages = [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        ...safeHistory.map(item => ({
          role: item.role === "model" ? "assistant" : item.role,
          content: item.parts[0].text
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
            "Authorization": "Bearer " + env.GROQ_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages,
            temperature: 0.8,
            max_tokens: 2048
          })
        }
      );

      if (!response.ok) {
        throw new Error("Groq failed");
      }

      const data = await response.json();

      const reply = data.choices?.[0]?.message?.content?.trim();

      if (reply) return reply;

      throw new Error("Empty Groq response");

    } catch (error) {
      throw new Error("Both chat providers failed");
    }
  }

  throw new Error("AI API keys are not configured");
}

async function generateImage(prompt, env) {
  if (!env.AI) {
    throw new Error("Cloudflare AI binding is missing");
  }

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-1-schnell",
    {
      prompt,
      steps: 8
    }
  );

  if (!result || typeof result.image !== "string") {
    throw new Error("Image generation failed");
  }

  return "data:image/png;base64," + result.image;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);

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

    // WEBSITE + HEALTH CHECK
    if (request.method === "GET") {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({
          success: true,
          name: "ESUKA AI",
          status: "Backend is running",
          modes: ["chat", "image"]
        }, 200, cors);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({
        success: false,
        error: "Website assets not configured"
      }, 500, cors);
    }

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "Method not allowed"
      }, 405, cors);
    }

    // API CORS CHECK
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({
        success: false,
        error: "Origin not allowed"
      }, 403, cors);
    }

    try {
      const body = await request.json();

      // IMAGE GENERATION
      if (body.mode === "image") {
        const prompt = String(
          body.prompt || body.message || ""
        ).trim();

        if (!prompt) {
          return json({
            success: false,
            error: "Please enter an image description"
          }, 400, cors);
        }

        if (prompt.length > 2048) {
          return json({
            success: false,
            error: "Image prompt is too long"
          }, 400, cors);
        }

        const image = await generateImage(prompt, env);

        return json({
          success: true,
          mode: "image",
          image,
          reply: "Tumhari image ready hai!"
        }, 200, cors);
      }

      // NORMAL CHAT
      const message = String(body.message || "").trim();

      if (!message) {
        return json({
          success: false,
          error: "Message is empty"
        }, 400, cors);
      }

      if (message.length > 10000) {
        return json({
          success: false,
          error: "Message is too long"
        }, 400, cors);
      }

      const history = Array.isArray(body.history)
        ? body.history
        : [];

      const reply = await generateChat(message, history, env);

      return json({
        success: true,
        mode: "chat",
        reply
      }, 200, cors);

    } catch (error) {
      return json({
        success: false,
        error: "ESUKA AI request failed. Please try again."
      }, 500, cors);
    }
  }
};
