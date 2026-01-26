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
const prompt = `You are a transcript editor. Fix obvious transcription errors, spelling mistakes, and missing punctuation while preserving meaning, names, and sentence order. Do NOT summarize or remove content. Keep the structure and line breaks similar. Return only the corrected transcript.\n\nTranscript:\n${transcript}`;

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

    await session.send({ prompt });
    await done;
  } else {
    const response = await session.sendAndWait({ prompt });
    const content = response?.data?.content ?? "";
    console.log(content.trim());
  }

  await session.destroy();
  await client.stop();
} catch (error) {
  await client.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
