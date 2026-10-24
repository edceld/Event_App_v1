import { existsSync } from "node:fs";
// Node preserves already-exported variables. Match Next's local-file priority.
for (const path of [".env.local", ".env"])
  if (existsSync(path)) process.loadEnvFile(path);
