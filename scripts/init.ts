import "./load-env";
import { initialize, db } from "../src/lib/db";
await initialize();
console.log("Database initialized.");
db().close();
