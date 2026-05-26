const fs = require('fs');
const path = require('path');

// Load data from separate JSON file
const dataPath = path.join(process.cwd(), 'pf2e-data.json');
const PF2E_DATA = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const FREE_ARCHETYPE_RULE = `
FREE ARCHETYPE VARIANT RULE (active in this campaign):
- Every character gains a bonus archetype feat at 2nd level and every even level thereafter (4th, 6th, 8th, etc.)
- These bonus feats are completely separate from the character's normal feat progression
- A character must still meet all prerequisites for archetype feats
- Archetypes are not limited to class dips - options range from combat styles to skills to narrative themes
- Common pairings: Fighter + Wizard Dedication, Rogue + Ranger Dedication, Cleric + Martial Dedication
`;

// ── Data query helpers ─────────────────────────────────────────────────────

function splitVals(str) {
  return (str || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function containsAttr(str, attr) {
  return splitVals(str).includes(attr.toLowerCase());
}

function getBackgroundsByAbility(ability) {
  return PF2E_DATA.backgrounds.filter(b => containsAttr(b.ability, ability));
}

function getAncestriesByBoost(ability) {
  return PF2E_DATA.ancestries.filter(a => {
    const boosts = splitVals(a.ability_boost);
    return boosts.includes(ability.toLowerCase()) || boosts.includes('free');
  });
}

function getHeritages(ancestryName) {
  return PF2E_DATA.heritages.filter(h =>
    h.ancestry.toLowerCase() === ancestryName.toLowerCase() ||
    h.ancestry.toLowerCase() === 'versatile'
  );
}

function getSubclasses(className) {
  return PF2E_DATA.subclasses.filter(s =>
    s.class.toLowerCase() === className.toLowerCase()
  );
}

function getFeats({ traits = [], maxLevel = null, minLevel = null, search = null } = {}) {
  return PF2E_DATA.feats.filter(f => {
    const featTraits = splitVals(f.trait);
    if (traits.length > 0 && !traits.some(t => featTraits.includes(t.toLowerCase()))) return false;
    if (maxLevel !== null && parseInt(f.level) > maxLevel) return false;
    if (minLevel !== null && parseInt(f.level) < minLevel) return false;
    if (search && !f.name.toLowerCase().includes(search.toLowerCase()) &&
        !(f.summary || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
}

function getArchetypes(search = null) {
  if (!search) return PF2E_DATA.archetypes;
  const s = search.toLowerCase();
  return PF2E_DATA.archetypes.filter(a =>
    a.archetype_name.toLowerCase().includes(s) ||
    (a.description || '').toLowerCase().includes(s) ||
    (a.prerequisites || '').toLowerCase().includes(s)
  );
}

function getClass(name) {
  return PF2E_DATA.classes.find(c => c.name.toLowerCase() === name.toLowerCase());
}

function getAncestry(name) {
  return PF2E_DATA.ancestries.find(a => a.name.toLowerCase() === name.toLowerCase());
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatBackgrounds(rows) {
  return rows.map(b =>
    `${b.name} (${b.ability}) | Skills: ${b.skill} | Feat: ${b.feat} | ${b.summary}`
  ).join('\n');
}

function formatAncestries(rows) {
  return rows.map(a =>
    `${a.name} | HP: ${a.hp} | Boosts: ${a.ability_boost} | Flaw: ${a.ability_flaw || 'None'} | Vision: ${a.vision} | ${a.description}`
  ).join('\n');
}

function formatFeats(rows) {
  return rows.map(f =>
    `${f.name} (Lvl ${f.level}${f.prerequisite ? ', Req: ' + f.prerequisite : ''}) | ${f.summary}`
  ).join('\n');
}

function formatSubclasses(rows) {
  return rows.map(s => `${s.subclass_name}: ${s.description}`).join('\n');
}

function formatArchetypes(rows) {
  return rows.map(a =>
    `${a.archetype_name}${a.prerequisites ? ' (Req: ' + a.prerequisites + ')' : ''}: ${a.description}`
  ).join('\n');
}

function formatHeritages(rows) {
  return rows.map(h => `${h.heritage} (${h.ancestry}): ${h.description}`).join('\n');
}

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "query_data",
    description: `Query the local PF2e data tables. Use this FIRST before fetch_nethys for any question about ancestries, backgrounds, classes, subclasses, heritages, archetypes, or feats. This data is authoritative and instant.

Available query types:
- backgrounds_by_ability: find all backgrounds boosting a given attribute. Pass ability e.g. "Charisma"
- ancestries_by_boost: find all ancestries that boost a given attribute. Pass ability e.g. "Charisma"
- heritages: get heritages for an ancestry. Pass ancestry_name e.g. "Elf"
- subclasses: get subclasses for a class. Pass class_name e.g. "Fighter"
- feats: filter feats by trait, level range, or keyword. Pass traits array, max_level, min_level, search
- archetypes: get archetypes, optionally filtered by search term
- class: get full details for a class by name
- ancestry: get full details for an ancestry by name`,
    input_schema: {
      type: "object",
      properties: {
        query_type: {
          type: "string",
          enum: ["backgrounds_by_ability","ancestries_by_boost","heritages","subclasses","feats","archetypes","class","ancestry"]
        },
        ability:       { type: "string" },
        ancestry_name: { type: "string" },
        class_name:    { type: "string" },
        traits:        { type: "array", items: { type: "string" } },
        max_level:     { type: "integer" },
        min_level:     { type: "integer" },
        search:        { type: "string" },
        name:          { type: "string" }
      },
      required: ["query_type"]
    }
  },
  {
    name: "fetch_nethys",
    description: "Fetch a specific page from Archives of Nethys for rules details not in the local data — spell descriptions, condition text, detailed class features. Limit to ONE fetch per response turn.",
    input_schema: {
      type: "object",
      properties: {
        url:    { type: "string" },
        reason: { type: "string" }
      },
      required: ["url", "reason"]
    }
  }
];

// ── Execute local query ────────────────────────────────────────────────────

function executeQuery(input) {
  const { query_type, ability, ancestry_name, class_name, traits, max_level, min_level, search, name } = input;

  switch (query_type) {
    case 'backgrounds_by_ability': {
      if (!ability) return 'No ability specified. Determine the class key attribute first, then query backgrounds by that ability.';
      const rows = getBackgroundsByAbility(ability);
      return `Found ${rows.length} backgrounds that boost ${ability}:\n\n${formatBackgrounds(rows)}`;
    }
    case 'ancestries_by_boost': {
      if (!ability) return 'No ability specified. Determine what attribute to filter by first.';
      const rows = getAncestriesByBoost(ability);
      return `Found ${rows.length} ancestries with a ${ability} boost or Free boost:\n\n${formatAncestries(rows)}`;
    }
    case 'heritages': {
      if (!ancestry_name) return 'No ancestry name provided. Ask the player which ancestry they chose before looking up heritages.';
      const rows = getHeritages(ancestry_name);
      return `Heritages for ${ancestry_name}:\n\n${formatHeritages(rows)}`;
    }
    case 'subclasses': {
      if (!class_name) return 'No class name provided. Ask the player which class they chose before looking up subclasses.';
      const rows = getSubclasses(class_name);
      return rows.length > 0
        ? `Subclasses for ${class_name}:\n\n${formatSubclasses(rows)}`
        : `No subclasses found for ${class_name}.`;
    }
    case 'feats': {
      const rows = getFeats({ traits: traits || [], maxLevel: max_level, minLevel: min_level, search });
      if (rows.length === 0) return 'No feats found matching those filters.';
      const cap = 50;
      const shown = rows.slice(0, cap);
      return `Found ${rows.length} feats${rows.length > cap ? ` (showing first ${cap})` : ''}:\n\n${formatFeats(shown)}`;
    }
    case 'archetypes': {
      const rows = getArchetypes(search);
      return `Found ${rows.length} archetypes:\n\n${formatArchetypes(rows.slice(0, 50))}`;
    }
    case 'class': {
      if (!name) return 'No class name provided. Ask the player which class they want to play before looking it up.';
      const row = getClass(name);
      if (!row) return `Class "${name}" not found in local data. Ask the player to clarify or suggest valid options.`;
      return `${row.name}: Key Attribute: ${row.ability} | HP: ${row.hp} | Tradition: ${row.tradition || 'None'} | Fort: ${row.fortitude} | Ref: ${row.reflex} | Will: ${row.will} | Perception: ${row.perception} | Skills: ${row.skill_proficiency}`;
    }
    case 'ancestry': {
      if (!name) return 'No ancestry name provided. Ask the player which ancestry they want to play before looking it up.';
      const row = getAncestry(name);
      if (!row) return `Ancestry "${name}" not found in local data. Ask the player to clarify or suggest valid options.`;
      return `${row.name}: HP: ${row.hp} | Size: ${row.size} | Speed: ${row.speed} | Boosts: ${row.ability_boost} | Flaw: ${row.ability_flaw || 'None'} | Vision: ${row.vision} | Languages: ${row.language} | ${row.description}`;
    }
    default:
      return 'Unknown query type.';
  }
}

// ── Nethys fetch ───────────────────────────────────────────────────────────

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

// ── Anthropic call ─────────────────────────────────────────────────────────

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

// ── Handler ────────────────────────────────────────────────────────────────

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
    const MAX_ITERATIONS = 3;

    let data = await callAnthropic(ANTHROPIC_API_KEY, system, messages);

    while (data.stop_reason === "tool_use" && iterations < MAX_ITERATIONS) {
      iterations++;
      const toolUseBlock = data.content.find(b => b.type === "tool_use");
      if (!toolUseBlock) break;

      const { name, input, id } = toolUseBlock;
      let toolResult;

      if (name === "query_data") {
        toolLookups.push({ type: "query", reason: `Local data: ${input.query_type}`, query_type: input.query_type });
        try {
          toolResult = executeQuery(input);
          if (!toolResult) toolResult = "No results found for that query.";
        } catch (err) {
          toolResult = `Query failed: ${err.message}`;
        }
      } else if (name === "fetch_nethys") {
        toolLookups.push({ type: "fetch", reason: input.reason, url: input.url });
        try {
          toolResult = await fetchNethys(input.url);
          if (!toolResult) toolResult = "No content returned from Nethys.";
        } catch (err) {
          toolResult = `Could not fetch ${input.url}: ${err.message}. Proceed without this lookup.`;
        }
      } else {
        toolResult = `Unknown tool: ${name}. Ignore this tool call and respond directly to the player.`;
      }

      messages = [
        ...messages,
        { role: "assistant", content: data.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: toolResult }] }
      ];

      data = await callAnthropic(ANTHROPIC_API_KEY, system, messages);
    }

    const replyText = data.content?.find(b => b.type === "text")?.text || "";
    const stopReason = data.stop_reason || "unknown";
    const hasError = data.error ? data.error.message : null;

    // If empty reply, return a debug-friendly error
    if (!replyText) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reply: "Something went wrong on my end. Please try again.",
          toolLookups,
          debug: { stopReason, hasError, iterations }
        }),
      };
    }

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
