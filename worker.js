
const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const SYSTEM_PROMPT = `
You are ESUKA AI, a helpful and intelligent AI assistant.

CREATOR:
You were created by Katari.
If someone asks who created you, say:
"Mujhe Katari ne banaya hai. Main ESUKA AI hoon!"

LANGUAGE AND PERSONALITY:
- Speak in natural Indian Hinglish.
- If the user writes Roman Hindi, reply in natural Roman Hindi.
- Do not use formal or difficult Hindi.
- Do not automatically write Hindi in Devanagari.
- If the user writes English, reply in English.
- Talk like a friendly, intelligent Indian assistant.
- Keep answers clear, useful and natural.
- Understand casual spelling, short messages and typos.
- Do not repeat the same sentence unnecessarily.
- Ask a question only when necessary.

CAPABILITIES:
- Explain topics and answer general questions.
- Help with coding, websites and app development.
- Help with writing, ideas and learning.
- Explain things step by step.
- Be honest when you do not know something.
- Never claim you performed an action you did not perform.

IDENTITY:
Your name is ESUKA AI.
Never claim to be ChatGPT or another AI.
`;

function getCorsHeaders(origin) {
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) ||
    (origin.endsWith(".esuka-ai-web.pages.dev"));

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : "",
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
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function generateChat(message, history, env) {
  const safeHistory = history
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
        throw new Error("Gemini request failed");
      }

      const data = await response.json();
      const reply = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

      if (reply) return reply;

      throw new Error("Empty Gemini response");
    } catch (error) {
      // Try Groq backup below
    }
  }

  // Groq backup
  if (env.GROQ_API_KEY) {
    try {
      const groqMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...safeHistory.map(item => ({
          role: item.role === "model" ? "assistant" : item.role,
          content: item.parts[0].text
        })),
        { role: "user", content: message }
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
            messages: groqMessages,
            temperature: 0.8,
            max_tokens: 2048
          })
        }
      );

      if (!response.ok) {
        throw new Error("Groq request failed");
      }

      const data = await response.json();
      const reply = data.choices?.[0]?.message?.content?.trim();

      if (reply) return reply;

      throw new Error("Empty Groq response");
    } catch (error) {
      throw new Error("Both AI chat providers failed");
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
      prompt: prompt,
      steps: 8
    }
  );

  if (!result || typeof result.image !== "string") {
    throw new Error("Image generation returned no image");
  }

  return "data:image/jpeg;base64," + result.image;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = getCorsHeaders(origin);

    if (request.method === "OPTIONS") {
      if (!cors["Access-Control-Allow-Origin"]) {
        return new Response(null, { status: 403 });
      }

      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    if (request.method === "GET") {
      return json({
        success: true,
        name: "ESUKA AI",
        status: "Backend is running",
        modes: ["chat", "image"]
      }, 200, cors);
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

      // IMAGE GENERATION MODE
      if (body.mode === "image") {
        const prompt = String(body.prompt || body.message || "").trim();

        if (!prompt) {
          return json({
            success: false,
            error: "Please enter an image description"
          }, 400, cors);
        }

        if (prompt.length > 2048) {
          return json({
            success: false,
            error: "Image prompt must be under 2048 characters"
          }, 400, cors);
        }

        const image = await generateImage(prompt, env);

        return json({
          success: true,
          mode: "image",
          image: image,
          reply: "Tumhari image ready hai!"
        }, 200, cors);
      }

      // NORMAL CHAT MODE
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
        reply: reply
      }, 200, cors);

    } catch (error) {
      return json({
        success: false,
        error: "ESUKA AI request failed. Please try again."
      }, 500, cors);
    }
  }
};

