import * as path from 'node:path';
import { Store } from './store';
import { createServer } from './server';

const dataDir = process.env.MORRIS_DATA_DIR ?? path.join(process.cwd(), 'data');
const dbPath = process.env.MORRIS_DB ?? path.join(dataDir, 'morris.db');
const store = new Store(dbPath);
const server = createServer(store);

// 默认端口 0：由系统分配空闲端口；可用 PORT 指定固定端口
const requestedPort = process.env.PORT ? Number(process.env.PORT) : 0;
server.listen(requestedPort, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : requestedPort;
  console.log(`Morris 遍历服务已启动: http://127.0.0.1:${port}`);
  console.log(`数据库: ${dbPath}`);
});

process.on('SIGINT', () => {
  server.close();
  store.close();
  process.exit(0);
});
