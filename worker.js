const ALLOWED_ORIGINS = [
  "https://esuka-ai-web.kataribhai1.workers.dev",
  "https://esuka-ai-web.pages.dev",
  "https://kataribhai1-alt.github.io"
];

const GROQ_MODEL = "openai/gpt-oss-20b";
const GEMINI_MODEL = "gemini-3.8-flash";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const EDIT_MODEL = "@cf/runwayml/stable-diffusion-v1-5-img2img";
const VISION_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

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

STYLE:
- Sound like a normal, friendly Indian person.
- Use simple, natural everyday language.
- Answer the actual question first.
- Keep normal replies short and conversational.
- Give details when asked.
- For technical help, explain in simple steps.
- Never make up facts or claim an action was completed when it was not.
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

function isImageRequest(message) {
  const text = String(message || "").toLowerCase().trim();

  if (!text) return false;

  const questionPattern =
    /\b(how|what|why|where|kaise|kya|kyun)\b.*\b(make|create|generate|edit|bana)\b/i;

  if (questionPattern.test(text)) return false;

  const imageWords =
    /\b(photo|image|picture|pic|portrait|wallpaper|poster|logo|drawing|illustration|artwork|thumbnail|tasveer|फोटो|तस्वीर|चित्र)\b/i;

  const creationWords =
    /\b(make|create|generate|draw|design|bana|banao|banaao|banado|bana do|taiyar karo|generate karo|create karo)\b/i;

  const directImagePhrase =
    /\b(draw|paint|illustrate)\b.*\b(tiger|lion|cat|dog|car|boy|girl|person|mountain|nature|bird|dragon)\b/i;

  return (
    (imageWords.test(text) && creationWords.test(text)) ||
    directImagePhrase.test(text)
  );
}

// GROQ CHAT
async function generateGroq(message, history, env) {
  if (!env.GROQ_API_KEY) {
    throw new Error("Groq API key missing");
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...getHistory(history).map(item => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.parts.map(part => part.text).join("\n")
    })),
    { role: "user", content: message }
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

  if (!reply) throw new Error("Groq returned an empty response");

  return reply;
}

// GEMINI BACKUP
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
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: SYSTEM_PROMPT }]
        },
        contents: [
          ...getHistory(history),
          { role: "user", parts: [{ text: message }] }
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

  if (!reply) throw new Error("Gemini returned no text");

  return reply;
}

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

// BASE64 HELPERS
function toBase64(bytes) {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 8192)
    );
  }

  return btoa(binary);
}

function imageDataToBytes(imageData) {
  if (typeof imageData !== "string") {
    throw new Error("Photo data is missing");
  }

  if (imageData.length > 7 * 1024 * 1024) {
    throw new Error("Photo is too large. Please use a smaller image.");
  }

  const match = imageData.match(
    /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i
  );

  if (!match) {
    throw new Error("Use a JPG, PNG or WebP photo");
  }

  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return {
    bytes,
    mime: match[1].toLowerCase()
  };
}

async function streamToDataUrl(result) {
  if (result?.image) {
    return "data:image/png;base64," + result.image;
  }

  if (result instanceof ReadableStream) {
    const buffer = await new Response(result).arrayBuffer();

    return "data:image/png;base64," +
      toBase64(new Uint8Array(buffer));
  }

  throw new Error("AI returned no image");
}

// NORMAL IMAGE GENERATION
async function generateImage(prompt, env) {
  if (!env.AI) {
    throw new Error("Cloudflare AI binding missing");
  }

  const cleanPrompt = String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error("Image prompt is required");
  }

  const result = await env.AI.run(IMAGE_MODEL, {
    prompt: cleanPrompt.slice(0, 1500),
    steps: 8
  });

  return await streamToDataUrl(result);
}

// PHOTO ANALYSIS
async function analyzePhoto(imageData, question, env) {
  if (!env.AI) {
    throw new Error("Cloudflare AI binding missing");
  }

  const { mime } = imageDataToBytes(imageData);

  const result = await env.AI.run(VISION_MODEL, {
    task: "query",
    image: imageData,
    question: String(question || "Describe this photo").slice(0, 1000),
    reasoning: false,
    stream: false,
    max_tokens: 500
  });

  const answer = result?.answer;

  if (!answer) {
    throw new Error("Photo analysis returned no answer");
  }

  return answer;
}

// PROMPT-BASED PHOTO EDITING
async function editPhoto(imageData, prompt, env) {
  if (!env.AI) {
    throw new Error("Cloudflare AI binding missing");
  }

  const cleanPrompt = String(prompt || "").trim();

  if (!cleanPrompt) {
    throw new Error("Please enter an editing prompt");
  }

  const { bytes } = imageDataToBytes(imageData);

  const result = await env.AI.run(EDIT_MODEL, {
    prompt: cleanPrompt.slice(0, 1500),
    image: Array.from(bytes),
    strength: 0.65,
    num_steps: 10,
    guidance: 7.5
  });

  return await streamToDataUrl(result);
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
        imageModel: IMAGE_MODEL,
        editModel: EDIT_MODEL,
        visionModel: VISION_MODEL,
        groqConfigured: Boolean(env.GROQ_API_KEY),
        geminiConfigured: Boolean(env.GEMINI_API_KEY),
        imageConfigured: Boolean(env.AI)
      }, 200, cors);
    }

    // WEBSITE ASSETS
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
      const mode = String(body.mode || "chat");
      const message = String(body.message || "").trim();

      // PHOTO ANALYSIS
      if (mode === "analyze") {
        const answer = await analyzePhoto(
          body.image,
          message || "Describe this photo",
          env
        );

        return json({
          success: true,
          mode: "analyze",
          reply: answer
        }, 200, cors);
      }

      // PHOTO EDITING
      if (mode === "edit") {
        const prompt = String(body.prompt || message).trim();

        const image = await editPhoto(
          body.image,
          prompt,
          env
        );

        return json({
          success: true,
          mode: "edit",
          image,
          prompt
        }, 200, cors);
      }

      // NORMAL CHAT OR IMAGE GENERATION
      if (!message && mode !== "image") {
        return json({
          success: false,
          error: "Message is required"
        }, 400, cors);
      }

      const useImage =
        mode === "image" ||
        isImageRequest(message);

      if (useImage) {
        const prompt = String(
          body.prompt || message
        ).trim();

        const image = await generateImage(prompt, env);

        return json({
          success: true,
          mode: "image",
          image,
          prompt
        }, 200, cors);
      }

      const reply = await generateChat(
        message,
        body.history || [],
        env
      );

      return json({
        success: true,
        mode: "chat",
        reply
      }, 200, cors);

    } catch (error) {
      console.error("ESUKA AI ERROR:", error.message);

      return json({
        success: false,
        error: String(
          error.message || "Unknown server error"
        )
      }, 500, cors);
    }
  }
};
