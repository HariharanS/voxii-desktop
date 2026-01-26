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

const sections = payload.sections || [
  "Agenda",
  "Summary",
  "Decisions",
  "Risks",
  "Actions",
];

const notes = payload.notes?.trim() ? `\n\nUser notes:\n${payload.notes}` : "";
const transcript = payload.transcript?.trim() || "";

const prompt = `You are a meeting assistant. Create a concise, structured summary in Markdown with these sections:\n${sections
  .map((s) => `- ${s}`)
  .join("\n")}\n\nRules:\n- Use short bullet points\n- Be factual, no speculation\n- Keep names and numbers accurate\n- If a section has no content, write "- None"\n\nTranscript:\n${transcript}${notes}\n\nReturn only Markdown.`;

const client = new CopilotClient();
await client.start();

const session = await client.createSession({
  model: payload.model || "gpt-4.1",
  streaming: true,
});

let finalContent = "";
const done = new Promise((resolve) => {
  session.on((event) => {
    if (event.type === "assistant.message_delta") {
      const delta = event.data.deltaContent || "";
      finalContent += delta;
      process.stdout.write(
        `${JSON.stringify({ type: "delta", content: delta })}\n`
      );
    } else if (event.type === "assistant.message") {
      finalContent = event.data.content || finalContent;
    } else if (event.type === "session.idle") {
      process.stdout.write(
        `${JSON.stringify({ type: "final", content: finalContent })}\n`
      );
      resolve();
    }
  });
});

try {
  await session.send({ prompt });
  await done;
  await session.destroy();
  await client.stop();
} catch (error) {
  await client.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
