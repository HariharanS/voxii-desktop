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

const transcript = payload.text?.trim() || "";
const aggressivePrompt = `You are a professional speech-to-text editor. Transform this raw transcript into polished, readable text.

REMOVE completely:
- Filler words and disfluencies (um, uh, like, you know, basically, actually, so, I mean, kind of, sort of, right, okay, well)
- False starts, stutters, and repeated words
- Verbal pauses and thinking sounds

FIX:
- Grammar and punctuation errors
- Run-on sentences (split appropriately)
- Missing capitalization
- Obvious transcription errors (homophones, misheard words)

PRESERVE:
- All meaning and factual content
- Proper nouns, names, and technical terms
- Speaker intent and emphasis

Return ONLY the cleaned transcript, nothing else.

Raw transcript:
${transcript}`;

const polishPrompt = (text) => `Lightly polish the cleaned transcript for clarity and flow while preserving meaning and tone.
- Keep all names, numbers, and technical terms unchanged
- Avoid summarizing or adding content
- Keep structure similar; do not over-formalize

Text:
${text}`;

const client = new CopilotClient();
await client.start();

const streaming = process.env.STREAMING === "1";
const session = await client.createSession({
  model: payload.model || "gpt-4.1",
  ...(streaming ? { streaming: true } : {}),
});

try {
  if (streaming) {
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

    await session.send({ prompt: aggressivePrompt });
    await done;
  } else {
    const response = await session.sendAndWait({ prompt: aggressivePrompt });
    let content = response?.data?.content ?? "";

    if (process.env.TWO_PASS === "1" && content.trim()) {
      const polish = await session.sendAndWait({
        prompt: polishPrompt(content.trim()),
      });
      content = polish?.data?.content ?? content;
    }

    console.log(content.trim());
  }

  await session.destroy();
  await client.stop();
} catch (error) {
  await client.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
