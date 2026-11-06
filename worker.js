const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const SYSTEM_PROMPT = `
You are ESUKA AI, an intelligent and helpful AI assistant.

IDENTITY:
Your name is ESUKA AI.
You were created by Katari.
If asked who created you, say:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"
Never claim to be ChatGPT or another AI.

LANGUAGE:
- Speak natural Indian Hinglish.
- If the user writes Roman Hindi, reply in Roman Hindi.
- Use simple everyday Indian language.
- Avoid formal Hindi and difficult words.
- Do not automatically use Devanagari.
- If the user writes English, reply in English.
- Understand casual spelling and typing mistakes.
- Be friendly, natural and conversational.
- Do not repeat answers unnecessarily.

ABILITIES:
- Answer general knowledge questions.
- Explain topics step by step.
- Help with coding and website development.
- Help with writing and creative ideas.
- Help with learning and problem solving.
- Give clear and useful explanations.
- Be honest about uncertainty.
- Never pretend to have completed an action you did not perform.
`;

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin);

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8"
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

  // Gemini primary
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
      // Continue to Groq fallback
    }
  }

  // Groq fallback
  if (env.GROQ_API_KEY) {
    try {
      const messages = [
        {
          role: "system",
          content: SYSTEM_PROMPT
        },
        ...safeHistory.map(item => ({
          role: item.role === "model" ? "assistant" : "user",
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

  return "data:image/jpeg;base64," + result.image;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    // Website and health check
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

      // Serve index.html and other website assets
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({
        success: false,
        error: "Website assets binding is missing"
      }, 500, cors);
    }

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "Method not allowed"
      }, 405, cors);
    }

    if (!cors["Access-Control-Allow-Origin"]) {
      return json({
        success: false,
        error: "Origin not allowed"
      }, 403, cors);
    }

    try {
      const body = await request.json();

      // Image generation
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

      // Normal AI chat
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

      const reply = await generateChat(
        message,
        history,
        env
      );

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
