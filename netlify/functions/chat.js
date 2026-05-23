const FREE_ARCHETYPE_RULE = `
FREE ARCHETYPE VARIANT RULE (active in this campaign):
- Every character gains a bonus archetype feat at 2nd level and every even level thereafter (4th, 6th, 8th, etc.)
- These bonus feats are completely separate from the character's normal feat progression
- A character must still meet all prerequisites for archetype feats
- This means every character effectively multiclasses for free
- Common pairings: Fighter + Wizard Dedication for a gish, Rogue + Ranger Dedication for a hunter, Cleric + Martial Dedication for a battle priest
- Archetypes are listed at: https://2e.aonprd.com/Archetypes.aspx
`;

const KNOWN_ANCESTRIES = [
  "dwarf","elf","gnome","goblin","halfling","human","leshy","orc",
  "catfolk","hobgoblin","kholo","kobold","lizardfolk","ratfolk","tengu","tripkee"
];

const KNOWN_VERSATILE_HERITAGES = [
  "aasimar","changeling","dhampir","duskwalker","nephilim",
  "half-elf","half-orc","aiuvarin","dromaar"
];

const KNOWN_CLASSES = [
  "alchemist","barbarian","bard","champion","cleric","druid","fighter",
  "investigator","monk","oracle","psychic","ranger","rogue","sorcerer",
  "summoner","swashbuckler","thaumaturge","witch","wizard"
];

const TOOLS = [
  {
    name: "fetch_nethys",
    description: "Fetch a specific page from Archives of Nethys to look up accurate PF2e rules. Use for specific rule details after you have already confirmed something exists. Limit to ONE fetch per response turn to avoid timeouts.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full Archives of Nethys URL." },
        reason: { type: "string", description: "Brief description shown to the player." }
      },
      required: ["url", "reason"]
    }
  },
  {
    name: "verify_exists",
    description: `Verify a game element exists in PF2e. Use this before discussing any ancestry, class, background, archetype, feat, or spell a player mentions. 

Known valid ancestries (no lookup needed): ${KNOWN_ANCESTRIES.join(", ")}
Known valid versatile heritages (no lookup needed): ${KNOWN_VERSATILE_HERITAGES.join(", ")}  
Known valid classes (no lookup needed): ${KNOWN_CLASSES.join(", ")}

Only call this tool for things NOT in the lists above. If something is in the lists, treat it as verified and skip this tool.`,
    input_schema: {
      type: "object",
      properties: {
        category_url: {
          type: "string",
          description: "Nethys listing page. Use: https://2e.aonprd.com/Ancestries.aspx for ancestries, https://2e.aonprd.com/Heritages.aspx for versatile heritages, https://2e.aonprd.com/Classes.aspx for classes, https://2e.aonprd.com/Archetypes.aspx for archetypes, https://2e.aonprd.com/Backgrounds.aspx for backgrounds."
        },
        term: { type: "string", description: "The exact name to verify." },
        reason: { type: "string", description: "Brief description shown to the player." }
      },
      required: ["category_url", "term", "reason"]
    }
  }
];

async function fetchNethys(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "PF2e-Character-Guide/1.0" },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Nethys returned ${res.status}`);
    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return text.slice(0, 3000);
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function verifyExists(categoryUrl, term) {
  const text = await fetchNethys(categoryUrl);
  const found = text.toLowerCase().includes(term.toLowerCase());
  return {
    found,
    summary: found
      ? `"${term}" was found in the Nethys listing at ${categoryUrl}.`
      : `"${term}" was NOT found in the Nethys listing at ${categoryUrl}. This does not appear to exist in Pathfinder 2e.`
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
      max_tokens: 1200,
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
    const MAX_ITERATIONS = 4;

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
          toolResult = `Could not fetch ${input.url}: ${err.message}. Please proceed without this lookup.`;
        }
      } else if (name === "verify_exists") {
        toolLookups.push({ type: "verify", reason: input.reason, url: input.category_url, term: input.term });
        try {
          const result = await verifyExists(input.category_url, input.term);
          toolLookups[toolLookups.length - 1].found = result.found;
          toolResult = result.summary;
        } catch (err) {
          toolResult = `Could not verify "${input.term}": ${err.message}. Treat as unverified and tell the player you could not confirm it.`;
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
