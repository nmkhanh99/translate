import { createServer } from "node:http";
import { createApp } from "./server.js";
import { REPO_ROOT } from "./paths.js";

function parseArgs(argv: string[]) {
  let host = "127.0.0.1";
  let port = parseInt(process.env.CFA_PORT || "8756", 10);
  let open = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") host = argv[++i];
    else if (a === "--port") port = parseInt(argv[++i], 10);
    else if (a === "--no-open") open = false;
  }
  return { host, port, open };
}

async function main() {
  const { host, port } = parseArgs(process.argv.slice(2));
  const app = createApp();
  const server = createServer(app);
  server.listen(port, host, () => {
    console.log(`▶ CFA Translate Daemon: http://${host}:${port}`);
    console.log(`  root=${REPO_ROOT}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
