# Morris 二叉树遍历与临时线索恢复解释后端

纯后端教学服务：输入一棵带唯一节点编号、任意字符串标签和左右子节点引用的二叉树，
用 **Morris 遍历** 计算中序 / 前序访问序列，并逐步解释临时线索（thread）的建立与拆除。
只做 API 与 CLI，不含网页。技术栈：TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖），
Windows 本地运行，不依赖 Docker / WSL / 外部在线服务。

## 快速开始

```powershell
npm install        # 仅需开发依赖 typescript / @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口，PORT=8080 可指定）
npm run demo       # 内置演示：B(A, D(C, null))，打印完整步骤
node dist/cli.js   # 查看全部 CLI 命令
```

数据目录默认为项目内 `data/`（可用环境变量 `MORRIS_DATA_DIR` 或 `MORRIS_DB` 覆盖）。

## 输入格式

```json
{
  "rootId": 2,
  "nodes": [
    { "id": 2, "label": "B", "left": 1, "right": 4 },
    { "id": 1, "label": "A", "left": null, "right": null },
    { "id": 4, "label": "D", "left": 3, "right": null },
    { "id": 3, "label": "C", "left": null, "right": null }
  ]
}
```

- 节点编号唯一且为整数；标签为任意字符串，允许重复。
- 树不必满足二叉搜索树的大小关系；空树（`rootId: null, nodes: []`）合法。
- 上限：节点数 10000，标签长度 1024（`src/validate.ts` 中常量）。

## 无栈算法的成立范围

Morris 遍历在**单棵连通二叉树**上成立：每个节点最多一个父节点、无环、从根可达全部节点。
此时「左子树的最右节点」的右指针必为空，可以安全地借用作临时返回边；再次回到祖先时
通过「前驱右指针已指向当前节点」识别线索并拆除。正式遍历核心（`src/morris.ts`）：

- 不使用递归，不使用显式栈保存待访问祖先，不调用任何现成遍历库；
- 只有 `current` / `predecessor` 两个指针作为算法辅助状态，即 O(1) 辅助空间；
- 访问记录完全来自真实步骤：中序在「无左子树」或「拆除线索后」访问，
  前序在「建立线索前」或「无左子树」访问，两种次序的访问时机不同；
- 临时线索只作用于本次计算的工作副本，保存的原树（SQLite 中的不可变版本）绝不被修改；
- 遍历结束后逐引用比较工作副本与输入，若不一致则抛出 `INTERNAL_RESTORE_FAILURE`，
  不发布完成报告。

校验阶段（`src/validate.ts`）独立进行，允许使用集合与栈：检查未知引用、自环、环、
同一节点两个父节点（共享子节点）、根不唯一 / 森林、不可达节点，拒绝一般有向图冒充树。
这些集合与栈不进入正式 Morris 核心。

## 实际内存构成（不宣称整个服务只占常数内存）

- **算法辅助状态**：O(1)（两个指针）。
- **保存的输入**：SQLite 中的不可变树版本，O(n) / 版本。
- **工作副本**：每次运行在堆上重建的节点对象，O(n)。
- **解释日志**：步骤对象与访问序列，O(n)（每个节点产生 O(1) 条步骤；
  前驱搜索步骤合计 O(n)）。`maxSteps` 只截断**日志记录**，遍历始终执行到完成并拆除全部线索。

## API

默认监听系统分配的空闲端口，启动日志打印实际地址。所有错误返回 `{ "error": 错误码, ... }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查与上限 |
| POST | `/trees` | 导入树（先校验），保存为不可变版本；同内容复用，同名新内容版本 +1 |
| POST | `/trees/validate` | 仅校验结构 |
| GET | `/trees` / `/trees/:id` | 列表 / 详情（含节点表） |
| POST | `/runs` | `{ treeId, order, maxSteps? }`，完整运行并原子保存 |
| GET | `/runs` / `/runs/:id` | 列表 / 元信息 |
| GET | `/runs/:id/steps/:seq` | 查询某一步的指针变化 |
| GET | `/runs/:id/verify` | 核验结构恢复与「每节点恰好访问一次」 |
| GET | `/runs/:id/report` | 导出完整报告（含步骤与树） |
| POST | `/compare` | `{ treeId }` 同树跑两种次序并对比 |

主要错误码：`VALIDATION_FAILED`（含 `UNKNOWN_REF` / `SELF_LOOP` / `CYCLE` /
`MULTIPLE_PARENTS` / `MULTIPLE_ROOTS` / `UNREACHABLE` / `DUPLICATE_ID` / `LIMIT_EXCEEDED`
等明细）、`BAD_ORDER`、`BAD_JSON`、`PAYLOAD_TOO_LARGE`、`TREE_NOT_FOUND`、`RUN_NOT_FOUND`、
`STEP_NOT_FOUND`、`INTERNAL_RESTORE_FAILURE`。

## CLI

```powershell
node dist/cli.js import tree.json --name demo   # 导入
node dist/cli.js validate tree.json             # 校验
node dist/cli.js run --tree 1 --order inorder   # 运行（--max-steps N 截短解释）
node dist/cli.js sequence --run 1               # 访问序列
node dist/cli.js steps --run 1                  # 全部步骤（节点表与边变化）
node dist/cli.js step --run 1 --seq 7           # 某一步的指针旧值/新值
node dist/cli.js verify --run 1                 # 核验结构恢复
node dist/cli.js compare --tree 1               # 中序 vs 前序
node dist/cli.js export --run 1 --out r.json    # 导出报告
node dist/cli.js trees / runs / show --tree 1   # 列表与节点表
node dist/cli.js demo                           # 内置演示
```

## 持久化与版本

SQLite（WAL）保存两张表：`trees`（不可变树版本，内容哈希去重，同名修改产生 version+1）
与 `runs`（运行方式、算法版本 `morris-1.0.0`、访问序列、解释步骤、结构恢复标志）。
更改标签或引用即产生新版本，旧报告仍引用旧 `treeId`，重启后可继续查询旧序列与解释。
每次运行都是完整计算后原子写入，不支持（也不需要）暂停后恢复中间临时线索。

## 演示与测试

`npm run demo` 演示根 B、左子 A、右子 D、D 的左子 C：中序 `A B C D`、前序 `B A D C`，
并展示前驱 A 的右指针 `null -> B`（建立）与 `B -> null`（拆除）的完整步骤。

`npm test` 覆盖：空树、单节点、左链、右链、重复标签、随机交错子树（以独立递归遍历
仅作小样本基准核对两种序列）、逐引用结构恢复比较、共享子节点 / 环 / 自环 / 未知引用 /
多根 / 重复编号等非法输入、解释截短（截短不提前结束遍历）、以及关闭后重开数据库的
重启查询。

## 限制

- 仅研究遍历时借用空右指针返回祖先；不做插入删除、平衡旋转、最优搜索树、表达式执行。
- 单进程服务，无鉴权，面向本地教学用途。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
