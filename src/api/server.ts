import { openDb, closeDb } from "../db.ts";
import { startServer } from "./http.ts";

const db = openDb();
const { server, port } = await startServer(db);
const line = `patent-claim-matcher listening on http://127.0.0.1:${port} (loopback only)`;
console.log(line);

const shutdown = () => {
  server.close(() => {
    closeDb(db);
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
