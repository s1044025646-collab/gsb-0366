import { resolve } from "node:path";
import { MorrisStore } from "./db.js";
import { createApp, listenOnFreePort } from "./http.js";

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (value !== undefined) args.set(key, value);
  }

  const dbPath = resolve(args.get("--db") ?? "data/morris.sqlite");
  const portText = args.get("--port") ?? process.env.PORT;
  const port = portText === undefined ? 0 : Number(portText);
  if (portText !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new Error("--port/PORT 必须是 0..65535 的整数；0 表示由系统选择空闲端口");
  }

  const store = new MorrisStore(dbPath);
  const server = createApp(store);
  const actualPort = await listenOnFreePort(server, port);

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`Morris 教学后端已启动：http://127.0.0.1:${actualPort}`);
  console.log(`SQLite 数据文件：${dbPath}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
