import "./load-env";
import { initialize, db } from "../src/lib/db";
import { createUser, type Role } from "../src/lib/auth";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
// Pass the initial password via process environment, never a command-line argument.
const [name, email, role = "admin"] = process.argv.slice(2);
let password = process.env.INITIAL_USER_PASSWORD;
if (name && email && !password && process.stdin.isTTY) {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: sink,
    terminal: true,
  });
  process.stdout.write("New password (12+ characters, hidden): ");
  const first = await rl.question("");
  process.stdout.write("\nConfirm password (hidden): ");
  const second = await rl.question("");
  rl.close();
  process.stdout.write("\n");
  if (first !== second) throw new Error("Passwords do not match");
  password = first;
}
if (!name || !email || !password) {
  console.error(
    'Usage: INITIAL_USER_PASSWORD=<secure password> npm run user:create -- "Name" email@example.com admin|supervisor|checkin',
  );
  process.exit(1);
}
await initialize();
await createUser(db(), name, email, role as Role, password);
console.log("User created.");
db().close();
