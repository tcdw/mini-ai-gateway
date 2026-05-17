import { $ } from "bun";
import { mkdir } from "node:fs/promises";

await Promise.all([
  mkdir(".agents", { recursive: true }),
  mkdir(".claude", { recursive: true }),
]);

console.log("-> Installing agent skills from agent-doc");
await $`bun run skills add ./agent-doc/skills --yes --agent claude-code codex gemini-cli`
  .env({ ...process.env, DISABLE_TELEMETRY: "1" })
  .quiet();

console.log("-> Installing agent skills from npm packages");
await $`bun run skills-npm --yes`.quiet();
