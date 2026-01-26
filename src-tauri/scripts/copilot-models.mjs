import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();

try {
  const models = await client.listModels();
  console.log(JSON.stringify(models));
  await client.stop();
} catch (error) {
  await client.stop();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
