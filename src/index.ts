import { SYSTEM_PROMPT } from "./system-prompt";
import { TOOLS } from "./tools";
import {
  createSupabaseClient,
  searchEvents,
  searchRoutes,
  searchPlaces,
} from "./supabase-queries";

// Env bindings
interface Env {
  AI: any; // Workers AI binding
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}

// Chat message type
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

// CORS headers — tillad din frontend at kalde denne Worker
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // Skift til "https://b-social.net" i produktion
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Parse the URL
    const url = new URL(request.url);

    if (url.pathname === "/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "b-social-chat" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      messages?: { role: string; content: string }[];
      message?: string;
    };

    // Support both { messages: [...] } and { message: "..." }
    let userMessages: ChatMessage[];

    if (body.messages && Array.isArray(body.messages)) {
      userMessages = body.messages.map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content,
      }));
    } else if (body.message) {
      userMessages = [{ role: "user", content: body.message }];
    } else {
      return jsonResponse({ error: "Mangler 'message' eller 'messages' felt" }, 400);
    }

    // Build the full conversation with system prompt
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...userMessages,
    ];

    // First AI call — may include tool calls
    const aiResponse = await env.AI.run("@cf/moonshotai/kimi-k2.5", {
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

    // If the model wants to call tools, execute them
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);

      // Add the assistant's tool-call message
      messages.push({
        role: "assistant",
        content: aiResponse.content || "",
        tool_calls: aiResponse.tool_calls,
      });

      // Execute each tool call
      for (const toolCall of aiResponse.tool_calls) {
        const fnName = toolCall.function.name;
        const fnArgs =
          typeof toolCall.function.arguments === "string"
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;

        let result: any;

        switch (fnName) {
          case "search_events":
            result = await searchEvents(supabase, fnArgs);
            break;
          case "search_routes":
            result = await searchRoutes(supabase, fnArgs);
            break;
          case "search_places":
            result = await searchPlaces(supabase, fnArgs);
            break;
          default:
            result = { error: `Ukendt funktion: ${fnName}` };
        }

        // Add tool result to conversation
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }

      // Second AI call — now with data from Supabase
      const finalResponse = await env.AI.run("@cf/moonshotai/kimi-k2.5", {
        messages,
      });

      return jsonResponse({
        reply: finalResponse.response || finalResponse.content || "",
        tool_calls_made: aiResponse.tool_calls.map((tc: any) => tc.function.name),
      });
    }

    // No tool calls — direct response
    return jsonResponse({
      reply: aiResponse.response || aiResponse.content || "",
      tool_calls_made: [],
    });
  } catch (err: any) {
    console.error("Chat error:", err);
    return jsonResponse(
      { error: "Noget gik galt. Prøv igen.", details: err.message },
      500
    );
  }
}

// Helper to create JSON responses with CORS
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
