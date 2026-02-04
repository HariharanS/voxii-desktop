import { CopilotClient } from "@github/copilot-sdk";
import fs from "fs/promises";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Missing input path");
  process.exit(1);
}

const raw = await fs.readFile(inputPath, "utf-8");
const cleaned = raw.replace(/^\uFEFF/, "").trim();
const payload = JSON.parse(cleaned);

const notes = payload.notes?.trim() ? `\n\nUser notes:\n${payload.notes}` : "";
const transcript = payload.transcript?.trim() || "";

const prompt = `You are a meeting assistant specialized in extracting action items.

Extract action items from the following meeting transcript and notes.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "items": [
    {
      "id": "unique-id-1",
      "task": "Clear description of what needs to be done",
      "assignee": "Name if mentioned, otherwise null",
      "dueDate": "ISO date string if mentioned (YYYY-MM-DD), otherwise null",
      "priority": "high | medium | low",
      "status": "pending",
      "context": "Brief quote or reference from transcript explaining why this action item exists"
    }
  ]
}

Rules:
- Only include clear, actionable tasks that were explicitly mentioned or strongly implied
- Infer priority from language cues:
  - "urgent", "ASAP", "critical", "immediately" = high
  - "should", "need to", "important" = medium  
  - "could", "might", "nice to have", "eventually" = low
- Do NOT invent assignees or dates that weren't mentioned
- Each task should be specific and verifiable
- Include 1-2 sentence context for each item
- Generate unique IDs using format "action-1", "action-2", etc.
- If no action items are found, return {"items": []}

TRANSCRIPT:
${transcript}${notes}

Return only the JSON object, nothing else.`;

const client = new CopilotClient();
const startedAt = Date.now();
const log = (message) => {
  const elapsed = Date.now() - startedAt;
  console.error(`[actions] +${elapsed}ms ${message}`);
};

log("init");
await client.start();
log("client.start complete");

log("createSession start");
const session = await client.createSession({
  model: payload.model || "gpt-4.1",
});
log("createSession complete");

try {
  log("sendAndWait start");
  const response = await session.sendAndWait({ prompt });
  log("sendAndWait complete");
  
  let content = response?.data?.content ?? "";
  
  // Try to extract JSON from the response
  content = content.trim();
  
  // Remove markdown code blocks if present
  if (content.startsWith("```json")) {
    content = content.slice(7);
  } else if (content.startsWith("```")) {
    content = content.slice(3);
  }
  if (content.endsWith("```")) {
    content = content.slice(0, -3);
  }
  content = content.trim();
  
  // Validate it's valid JSON
  try {
    const parsed = JSON.parse(content);
    // Ensure it has the expected structure
    if (!parsed.items) {
      parsed.items = [];
    }
    // Output clean JSON
    process.stdout.write(JSON.stringify(parsed, null, 2));
  } catch (parseError) {
    log(`JSON parse error: ${parseError.message}`);
    // Return empty items if parsing fails
    process.stdout.write(JSON.stringify({ items: [] }));
  }

  log("destroy session");
  await session.destroy();
  log("client.stop");
  await client.stop();
} catch (error) {
  await client.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
