const FREE_ARCHETYPE_RULE = `
FREE ARCHETYPE VARIANT RULE (active in this campaign):
- Every character gains a bonus archetype feat at 2nd level and every even level thereafter (4th, 6th, 8th, etc.)
- These bonus feats must be spent on archetype feats and are completely separate from the character's normal feat progression
- A character must still meet all prerequisites for archetype feats
- This rule means every character effectively multiclasses for free, so players should think about what archetype complements their class
- Common pairings: Fighter + Wizard Dedication for a gish, Rogue + Ranger Dedication for a hunter, Cleric + Martial Dedication for a battle priest
- Archetypes are listed at: https://2e.aonprd.com/Archetypes.aspx
`;

const TOOLS = [
  {
    name: "fetch_nethys",
    description: "Fetch a specific page from the Archives of Nethys (2e.aonprd.com) to look up accurate PF2e rules. Use this when a player asks about a specific ancestry, class, background, feat, spell, condition, or rule. Always prefer this over relying on your training data for specific rules details.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The full Archives of Nethys URL to fetch. Examples: https://2e.aonprd.com/Ancestries.aspx?ID=1 (Dwarf), https://2e.aonprd.com/Classes.aspx?ID=7 (Fighter), https://2e.aonprd.com/Archetypes.aspx for the archetype list."
        },
        reason: {
          type: "string",
          description: "Brief description of what you are looking up, shown to the player."
        }
      },
      required: ["url", "reason"]
    }
  },
  {
    name: "verify_exists",
    description: "Verify that an ancestry, class, background, archetype, or other game element actually exists in Pathfinder 2e by checking the Archives of Nethys category listing page. Use this BEFORE discussing any game element a player mentions that you are not completely certain exists in PF2e — especially ancestries, classes, and archetypes. If the element does not appear in the listing, it does not exist in PF2e and you must tell the player.",
    input_schema: {
      type: "object",
      properties: {
        category_url: {
          type: "string",
          description: "The Nethys listing page URL for the relevant category. Use: https://2e.aonprd.com/Ancestries.aspx for ancestries, https://2e.aonprd.com/Classes.aspx for classes, https://2e.aonprd.com/Archetypes.aspx for archetypes, https://2e.aonprd.com/Backgrounds.aspx for backgrounds, https://2e.aonprd.com/Feats.aspx for feats."
        },
        term: {
          type: "string",
          description: "The exact name the player used that you want to verify exists in PF2e."
        },
        reason: {
          type: "string",
          description: "Brief description of what you are verifying, shown to the player."
        }
      },
      required: ["category_url", "term", "reason"]
    }
  }
];

async function fetchNethys(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "PF2e-Character-Guide/1.0" }
  });
  if (!res.ok) throw new Error(`Nethys returned ${res.status}`);
  const html = await res.text();

  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return text.slice(0, 3000);
}

async function verifyExists(categoryUrl, term) {
  const text = await fetchNethys(categoryUrl);
  const termLower = term.toLowerCase();
  const found = text.toLowerCase().includes(termLower);
  return {
    found,
    summary: found
      ? `"${term}" was found in the Archives of Nethys listing at ${categoryUrl}.`
      : `"${term}" was NOT found in the Archives of Nethys listing at ${categoryUrl}. This element does not appear to exist in Pathfinder 2e.`
  };
}

async function callAnthropic(apiKey, system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system,
      messages,
      tools: TOOLS,
    }),
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
    const system = body.system + "\n\n" + FREE_ARCHETYPE_RULE;
    let messages = body.messages;
    let toolLookups = [];
    let iterations = 0;
    const MAX_ITERATIONS = 5;

    let data = await callAnthropic(ANTHROPIC_API_KEY, system, messages);

    while (data.stop_reason === "tool_use" && iterations < MAX_ITERATIONS) {
      iterations++;
      const toolUseBlock = data.content.find(b => b.type === "tool_use");
      if (!toolUseBlock) break;

      const { name, input, id } = toolUseBlock;
      let toolResult;

      if (name === "fetch_nethys") {
        toolLookups.push({ type: "fetch", reason: input.reason, url: input.url });
        try {
          toolResult = await fetchNethys(input.url);
        } catch (err) {
          toolResult = `Could not fetch ${input.url}: ${err.message}`;
        }
      } else if (name === "verify_exists") {
        toolLookups.push({ type: "verify", reason: input.reason, url: input.category_url, term: input.term });
        try {
          const result = await verifyExists(input.category_url, input.term);
          toolResult = result.summary;
        } catch (err) {
          toolResult = `Could not verify: ${err.message}`;
        }
      }

      messages = [
        ...messages,
        { role: "assistant", content: data.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: toolResult }]
        }
      ];

      data = await callAnthropic(ANTHROPIC_API_KEY, system, messages);
    }

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
