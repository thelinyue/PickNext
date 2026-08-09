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
- 登录会话密钥首次启动时自动生成并保存在 SQLite 中，无需配置额外密钥。

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

## Docker Compose 部署

v0.1.1 镜像发布在 GitHub Container Registry，仅提供 `linux/amd64`：

```text
ghcr.io/thelinyue/picknext:0.1.1
```

在部署目录创建 `docker-compose.yml`：

```yaml
services:
  picknext:
    image: ghcr.io/thelinyue/picknext:0.1.1
    ports:
      - "${APP_PORT:-5560}:5560"
    environment:
      TZ: ${TZ:-Asia/Shanghai}
    volumes:
      - ./data:/data
    restart: unless-stopped
```

如需修改宿主机端口或时区，在同一目录创建 `.env`；不创建时使用默认值：

```dotenv
APP_PORT=5560
TZ=Asia/Shanghai
```

启动并检查运行状态：

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f picknext
```

若 GHCR 包尚未设置为 Public，需要先使用具有 `read:packages` 权限的 GitHub Token 登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub用户名> --password-stdin
```

浏览器访问 `http://服务器地址:5560`。首次打开会引导创建管理员。SQLite 数据保存在 Compose 文件同目录的 `./data/picknext.db`，重新创建或升级容器不会删除数据。请妥善备份整个 `./data` 目录。

服务首次启动会自动生成登录会话签名密钥并保存在同一个 SQLite 数据库中，部署者无需配置。只要保留 `./data` 目录，重启或升级容器不会影响现有登录状态。

升级镜像版本时，先备份数据卷，再修改 `image` 标签并运行：

```bash
docker compose pull
docker compose up -d
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | 容器时区，使用 IANA 时区名，例如 `UTC`、`America/New_York`。 |
| `APP_PORT` | `5560` | Compose 使用的宿主机端口，不改变容器内统一端口。 |
| `PORT` | `5560` | Web、API 和健康检查共用的容器端口；使用上方 Compose 时不要修改。 |
| `DATABASE_PATH` | `/data/picknext.db` | SQLite 文件位置；使用 `./data:/data` 挂载时不要修改。 |
| `HOST` | `0.0.0.0` | 服务监听地址；容器部署时不要改为 `127.0.0.1`。 |
| `NODE_ENV` | `production` | 已在镜像中设置，无需在 Compose 中重复配置。 |

仓库自带的 `docker-compose.yml` 使用本地 `Dockerfile` 构建，适合开发或自行修改代码后的验证：

```bash
docker compose up -d --build
```

## 工程结构

- `apps/server`：Fastify API、SQLite 事务、静态文件托管。
- `apps/web`：React 移动端 PWA。
- `packages/shared`：Zod 请求/响应 Schema 与公共类型。
- `packages/pick-engine`：无数据库依赖的纯 TypeScript Pick 算法。
- `migrations`：只追加的手写 SQLite migration。

产品边界、算法规则和验收标准见 [REQUIREMENTS.md](./REQUIREMENTS.md)。
