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

const prompt = `Improve the selected text for clarity and concision while preserving meaning, names, numbers, and tone. Return only the improved text.\n\nSelected text:\n${payload.text}`;

const client = new CopilotClient();
await client.start();

const session = await client.createSession({
  model: payload.model || "gpt-4.1",
});

try {
  const response = await session.sendAndWait({ prompt });
  const content = response?.data?.content ?? "";
  console.log(content.trim());
  await session.destroy();
  await client.stop();
} catch (error) {
  await client.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
