# PickNext

PickNext 是一款面向唱歌爱好者的个人曲库与下一首选择工具：整理自己的会唱歌曲，准备下一次 KTV，并让 PickNext 帮你决定下一首唱什么。

它适合部署在家庭服务器、NAS 或内网主机上，通过浏览器和移动端 PWA 使用。PickNext 不提供排麦、聚会点歌或社交平台功能。

## 快速部署

### 1. 准备 Compose 文件

在部署目录创建 `docker-compose.yml`：

```yaml
services:
  picknext:
    image: ghcr.io/thelinyue/picknext:latest
    ports:
      - "5560:5560"
    environment:
      TZ: Asia/Shanghai
    volumes:
      - ./data:/data
    restart: unless-stopped
```

该配置会把数据库保存到 Compose 文件同目录的 `./data` 目录。重新创建或升级容器不会删除该目录中的数据。

### 2. 启动服务

```bash
docker compose pull
docker compose up -d
docker compose ps
```

查看启动日志：

```bash
docker compose logs -f picknext
```

### 3. 首次访问

浏览器访问：

```text
http://服务器地址:5560
```

首次打开时，按照页面引导创建管理员账号。完成初始化后即可登录并开始维护曲库。

### 镜像访问权限

当前镜像发布到 GitHub Container Registry，仅提供 `linux/amd64` 架构。如果 GHCR 包尚未设置为 Public，需要先使用具有 `read:packages` 权限的 GitHub Token 登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub用户名> --password-stdin
```

## 部署配置

### 修改宿主机端口和时区

宿主机端口可以在 Compose 文件中单独修改，容器内部端口保持为 `5560`：

```yaml
ports:
  - "8080:5560"
environment:
  TZ: UTC
```

修改后重新创建容器：

```bash
docker compose up -d
```

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | 容器时区，使用 IANA 时区名，例如 `UTC`、`America/New_York`。 |
| `PORT` | `5560` | Web、API 和健康检查使用的容器端口；使用推荐 Compose 配置时不要修改。 |
| `DATABASE_PATH` | `/data/picknext.db` | SQLite 数据库位置；使用 `./data:/data` 挂载时不要修改。 |
| `HOST` | `0.0.0.0` | 服务监听地址；容器部署时不要改为 `127.0.0.1`。 |
| `NODE_ENV` | `production` | 生产运行模式，镜像中已设置。 |

会话签名密钥会在首次启动时自动生成并保存到同一个 SQLite 数据库中，无需额外配置。只要保留 `./data` 目录，重启或升级容器不会影响现有登录状态。

## 数据备份与恢复

PickNext 使用 SQLite 数据库保存账号、曲库和 Pick 历史。升级镜像或执行迁移前，请先备份整个 `./data` 目录。

也可以使用应用内的 SQLite 原生备份和只读完整性检查：

```bash
docker compose exec picknext node apps/server/dist/backup.js backup /data/picknext.db /data/picknext.db.backup
docker compose exec picknext node apps/server/dist/backup.js check /data/picknext.db.backup
```

恢复时先停止服务，将经过检查的数据库文件放回部署目录的 `./data/picknext.db`，再启动容器：

```bash
docker compose stop picknext
docker compose up -d
```

数据库迁移采用追加式 SQL。迁移失败时请保留原数据库文件和备份，不要删除 SQLite 的 `-wal` 或 `-shm` 文件后强行启动。

## 升级镜像

升级前先备份 `./data` 目录，然后拉取并重新创建容器：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

使用 `latest` 标签时，建议在升级后查看日志，确认迁移和服务启动均已完成：

```bash
docker compose logs --tail=100 picknext
```

如果需要回退到某个已发布版本，可以将 Compose 文件中的镜像改为对应版本标签，再执行相同的拉取和重建命令。回退前同样应保留数据库备份。

## 常见注意事项

- PickNext 当前只发布 `linux/amd64` 镜像；在 ARM 主机上需要确认 Docker 的兼容运行能力，或自行构建镜像。
- 不要删除或移动部署目录中的 `./data`；其中包含数据库和应用运行所需的数据。
- 不要把容器端口 `5560` 映射到只允许容器内部访问的地址，否则其他设备无法打开网页。
- SQLite 适合单容器、低并发的家庭或内网部署；不要直接把同一个数据库文件交给多个应用实例同时写入。
- 网络访问、反向代理、HTTPS 和外部身份认证不由 PickNext 自动配置，请根据部署环境自行处理。

## 产品能力

- 管理会唱曲库、待学清单和个人歌曲资料。
- 按语种、曲风、难度、星级和演唱类型筛选下一首歌曲。
- 使用“下一次 KTV”歌单准备演唱顺序，并在唱完后自动更新状态。
- 保存演唱历史，结合近期演唱和久未演唱情况减少重复感。
- 支持歌词计时显示、歌曲导入、个人数据导出和 PWA 安装。

歌词功能只提供计时显示、手动校正和跟唱辅助，不包含音频播放、录音或音准评分。

产品边界、算法规则和验收标准见 [REQUIREMENTS.md](./REQUIREMENTS.md)。版本变化见 [CHANGELOG.md](./CHANGELOG.md)。
