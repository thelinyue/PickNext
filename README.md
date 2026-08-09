# PickNext

PickNext（话筒递给我）是一款为唱歌爱好者设计的个人曲库与下一首选择工具。它用可复现的加权无放回队列减少重复感，同时始终把选择限制在用户自己的会唱曲库中。

## 本地开发

要求 Node.js 24 LTS 和 pnpm 11。

```bash
pnpm install
pnpm dev
```

- Web 与 API：http://localhost:5560
- 首次打开会引导创建管理员。
- 默认数据库位于 `data/picknext.db`，可用 `DATABASE_PATH` 修改。
- 生产环境必须设置至少 32 位的 `JWT_SECRET`。

## 发布检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

已提供 Playwright 主路径测试：安装 Chromium 后运行 `pnpm test:e2e`。

## 演示测试数据

显式设置 `ALLOW_TEST_SEED=1` 后可以重复生成演示数据；脚本只重置固定的 `*_demo` 账号，不删除真实用户：

```powershell
$env:ALLOW_TEST_SEED='1'
pnpm --filter @picknext/server seed:test
```

容器中执行：

```bash
docker exec -e ALLOW_TEST_SEED=1 <容器名> node apps/server/dist/seed-test-data.js
```

所有演示账号密码均为 `PickNext123!`：

| 账号 | 测试场景 |
|---|---|
| `admin_demo` | 管理员、完整曲库和个人元数据 |
| `new_demo` | 空个人曲库、全部曲库冷启动 |
| `learning_demo` | 只有待学歌曲 |
| `repertoire_demo` | 丰富会唱曲库、历史和普通歌单 |
| `ktv_demo` | “下一次 KTV”优先候选池 |
| `recent_demo` | 最近 10 首限制与自动放宽 |
| `single_artist_demo` | 单歌手候选池与软降权 |
| `filter_demo` | 多语种、曲风、难度和演唱类型筛选 |
| `snooze_demo` | 大部分歌曲处于冷藏期 |
| `skip_demo` | 同一歌曲连续 3 个场次跳过 |

## Docker

创建 `.env`：

```text
JWT_SECRET=请替换为至少32位的随机字符串
```

然后运行：

```bash
docker compose up --build
```

应用地址为 http://localhost:5560，SQLite 数据保存在命名卷 `picknext-data`。镜像使用非 root 用户，内置健康检查；同一 Dockerfile 可用于 amd64 与 arm64 的 buildx 构建。

容器默认使用 `Asia/Shanghai`（东八区）。如需其他时区，在 `.env` 中设置 IANA 时区名，例如 `TZ=UTC` 或 `TZ=America/New_York`，然后重新创建容器。

## 工程结构

- `apps/server`：Fastify API、SQLite 事务、静态文件托管。
- `apps/web`：React 移动端 PWA。
- `packages/shared`：Zod 请求/响应 Schema 与公共类型。
- `packages/pick-engine`：无数据库依赖的纯 TypeScript Pick 算法。
- `migrations`：只追加的手写 SQLite migration。

产品边界、算法规则和验收标准见 [REQUIREMENTS.md](./REQUIREMENTS.md)。
