const NETHYS_TOOL = {
  name: "fetch_nethys",
  description: "Fetch a page from the Archives of Nethys (2e.aonprd.com) to look up accurate PF2e rules. Use this when a player asks about a specific ancestry, class, background, feat, spell, condition, or rule that you want to verify or give precise details on. Construct the correct URL based on what is being looked up.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The full Archives of Nethys URL to fetch. Examples: https://2e.aonprd.com/Ancestries.aspx?ID=1 (Dwarf), https://2e.aonprd.com/Classes.aspx?ID=7 (Fighter), https://2e.aonprd.com/Feats.aspx?ID=1, https://2e.aonprd.com/Backgrounds.aspx?ID=1. For listing pages use: https://2e.aonprd.com/Ancestries.aspx, https://2e.aonprd.com/Classes.aspx etc."
      },
      reason: {
        type: "string",
        description: "Brief description of what you are looking up and why, shown to the player."
      }
    },
    required: ["url", "reason"]
  }
};

async function fetchNethys(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "PF2e-Character-Guide/1.0" }
  });
  if (!res.ok) throw new Error(`Nethys returned ${res.status}`);
  const html = await res.text();

  // Strip scripts, styles, nav
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Trim to ~3000 chars to keep token cost reasonable
  return text.slice(0, 3000);
}

async function callAnthropic(apiKey, system, messages, allowTools) {
  const body = {
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    system,
    messages,
  };
  if (allowTools) body.tools = [NETHYS_TOOL];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key not configured" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  try {
    const messages = body.messages;
    const system = body.system;

    // First call — model may decide to use the fetch tool
    let data = await callAnthropic(ANTHROPIC_API_KEY, system, messages, true);

    // Agentic loop: keep going while the model wants to use tools
    let toolLookups = [];
    let iterations = 0;
    const MAX_ITERATIONS = 3;

    while (data.stop_reason === "tool_use" && iterations < MAX_ITERATIONS) {
      iterations++;
      const toolUseBlock = data.content.find(b => b.type === "tool_use");
      if (!toolUseBlock) break;

      const { url, reason } = toolUseBlock.input;
      toolLookups.push({ url, reason });

      let nethysContent;
      try {
        nethysContent = await fetchNethys(url);
      } catch (err) {
        nethysContent = `Could not fetch ${url}: ${err.message}`;
      }

      // Feed the tool result back and call again
      const updatedMessages = [
        ...messages,
        { role: "assistant", content: data.content },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: nethysContent,
          }]
        }
      ];

      data = await callAnthropic(ANTHROPIC_API_KEY, system, updatedMessages, true);
    }

    // Return the final text response plus metadata about what was looked up
    const replyText = data.content?.find(b => b.type === "text")?.text || "";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: replyText, toolLookups }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to reach Anthropic API", detail: err.message }),
    };
  }
};
