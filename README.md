# Morris 二叉树遍历与临时线索恢复解释后端

这是一个只包含后端 API 与 CLI 的本地 TypeScript / Node.js / SQLite 教学服务。它在工作副本上自行实现 Morris 中序、前序遍历，逐笔解释“借用空右指针返回祖先”的临时线索如何建立、如何拆除，并原子保存树版本、运行参数、算法版本、序列和步骤报告。

## 适用范围

- 输入是普通二叉树，不要求满足二叉搜索树的键值大小关系。
- 节点编号唯一；标签可以是任意字符串，也允许重复。
- 空树合法：`{ "rootId": null, "nodes": [] }`。
- 只研究 Morris 遍历，不实现插入、删除、平衡旋转、最优搜索树或表达式执行。
- 不把验证阶段使用的集合、栈或递归带入正式 Morris 核心。
- 不支持暂停后带着临时线索恢复运行；重启后读取的是已完成并已恢复结构的持久化结果。

## 无栈算法说明

Morris 遍历的“无栈”是指正式遍历不用递归调用栈，也不用显式数据结构保存待返回祖先。当前节点有左子树时：

1. 从当前节点的左孩子开始，沿右指针找到左子树的中序前驱。
2. 若前驱右指针为空，把它临时改成当前节点，然后当前节点进入左子树。
3. 若前驱右指针已经指回当前节点，说明左子树遍历完成；把右指针改回 `null`，再进入右子树。

中序在“发现旧线索并拆除”后访问当前节点；前序在“建立新线索并进入左子树前”访问当前节点。没有左孩子时，两种次序都立即访问该节点。

该算法只需要少量游标和前驱变量即可操作树结构，因此**遍历辅助游标**是常数规模；但完整服务不是常数内存：

- 保存输入和不可变树版本需要 O(n)。
- 工作副本需要 O(n)，确保不修改保存的原树。
- 教学解释日志、访问序列和持久化 JSON 需要 O(n) 到 O(n) 级步骤空间；典型 Morris 总移动次数为 O(n)，每节点建拆线索各一次。
- SQLite 数据库、HTTP 请求体和 CLI 输出也各自占用空间。

## Windows 本地要求

- Node.js 25+（使用内置 `node:sqlite`，不需要 Docker、WSL、付费服务或外部在线 API）。
- npm。
- SQLite 数据默认保存在项目内 `data/morris.sqlite`。

## 构建、测试、启动和演示

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

默认 `npm start` 使用端口 `0`，Node 会自动选择本机空闲 TCP 端口，启动日志会打印实际地址。指定端口：

```powershell
npm start -- --port 8080
$env:PORT="8080"; npm start
npm start -- --db data/custom.sqlite --port 8080
```

## HTTP API

所有请求和响应均为 JSON。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/trees` | 导入或去重返回已有树版本 |
| `GET` | `/trees` | 列出所有不可变树版本 |
| `GET` | `/trees/:treeId?version=1` | 查询某版本；省略版本取最新 |
| `POST` | `/trees/:treeId/versions` | 基于既有 treeId 创建新版本 |
| `POST` | `/trees/:treeId/validate?version=1` | 单独校验结构 |
| `POST` | `/trees/:treeId/runs/inorder?version=1` | 完整运行中序并原子保存 |
| `POST` | `/trees/:treeId/runs/preorder?version=1` | 完整运行前序并原子保存 |
| `GET` | `/runs?treeId=1` | 查看运行列表 |
| `GET` | `/runs/:runId` | 查看完整结果和步骤 |
| `GET` | `/runs/:runId/order` | 查看访问顺序 |
| `GET` | `/runs/:runId/steps/:stepIndex` | 查询某一步指针变化 |
| `GET` | `/runs/:runId/verify` | 逐边核验结构恢复 |
| `GET` | `/runs/:firstRunId/compare/:secondRunId` | 比较两种次序 |
| `GET` | `/runs/:runId/report?maxSteps=10` | 导出报告；截断只影响展示 |

导入示例：

```powershell
$body = Get-Content -Raw examples\demo.json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/trees -ContentType 'application/json' -Body $body
```

演示树的核对结果：

- 中序：`A, B, C, D`
- 前序：`B, A, D, C`
- `A.right` 从 `null` 临时变为 `B`，处理完 `A` 所在左子树后再从 `B` 恢复为 `null`。

## CLI

```powershell
npm run cli -- import --file examples/demo.json
npm run cli -- validate 1
npm run cli -- run 1 inorder
npm run cli -- run 1 preorder
npm run cli -- order 1
npm run cli -- step 1 3
npm run cli -- verify 1
npm run cli -- compare 1 2
npm run cli -- report 1 --max-steps 10 --out data/report.json
npm run cli -- new-version 1 --file examples/demo.json
npm run cli -- list
npm run cli -- demo
```

CLI 的 JSON 输出包含当前节点、前驱、指针旧值/新值、本步实际经过的边及当前活动线索；完整原树边集合在结果的 `beforeEdges` 中保存一次，`afterEdges` 用于逐边恢复核验。`--max-steps` 只截断展示；计算已完整结束，所有临时线索均已拆除。

## 输入格式和校验

```json
{
  "rootId": "B",
  "nodes": [
    { "id": "B", "label": "任意字符串", "left": "A", "right": "D" },
    { "id": "A", "label": "重复也可以", "left": null, "right": null },
    { "id": "D", "label": "D", "left": "C", "right": null },
    { "id": "C", "label": "C", "left": null, "right": null }
  ]
}
```

默认上限：最多 5000 个节点，单个标签最多 500 个字符。超限请求不会进入 Morris 核心。

错误码：

- `EMPTY_INPUT`、`INVALID_ARGUMENT`：请求或字段格式错误。
- `MAX_NODES_EXCEEDED`、`LABEL_TOO_LONG`：超过防护上限。
- `DUPLICATE_NODE_ID`：节点编号重复。
- `INVALID_NODE_ID`：节点编号不是非空字符串。
- `UNKNOWN_REFERENCE`：左右孩子引用不存在。
- `SELF_REFERENCE`：节点直接指向自己。
- `CYCLE_DETECTED`：存在环。
- `DUPLICATE_PARENT`：同一节点被两个父边引用，即一般有向图共享节点。
- `MULTIPLE_ROOTS`：存在多个无父节点的根。
- `ROOT_NOT_FOUND`：根缺失或声明根与结构根不一致。
- `UNREACHABLE_NODE`：存在从根不可达节点。
- `NOT_FOUND`：树、版本或运行不存在。
- `INTERNAL_INVARIANT_FAILED`：建拆数量、活动线索、结构逐边比较或每节点恰好访问一次等内部诊断失败。

## 版本与持久化

- 树内容按规范化 JSON 的 SHA-256 去重；相同内容不会重复插入。
- 对同一 `treeId` 修改标签或引用会生成新版本。
- 每次运行记录 `tree_id`、`tree_version`、`mode`、`algorithm_version`、访问序列、完整步骤、前后边集合和恢复核验结果。
- 新版本不覆盖旧版本，因此旧报告仍能定位旧节点和旧标签。
- 计算和插入在 SQLite 事务中提交；内部不变量失败时抛出诊断，不发布成功完成报告。

## 项目结构

```text
src/types.ts       类型、错误码和限制
src/validation.ts  独立结构校验
src/morris.ts      Morris 核心与结构恢复检查
src/reference.ts   仅测试使用的递归基准
src/db.ts          SQLite 版本、运行、比较和报告
src/http.ts        JSON HTTP 路由
src/server.ts      端口和数据目录启动入口
src/cli.ts         本地 CLI 与演示
test/              Node.js 内置测试
```
