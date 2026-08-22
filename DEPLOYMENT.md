# Hướng Dẫn Triển Khai & Kiến Trúc Hệ Thống

Tài liệu này giải thích **nguyên lý nền tảng (first principles)** của codebase hiện tại, cách **triển khai (deploy)** ứng dụng lên VPS, và cách **sử dụng** ứng dụng/công cụ trong repo. Xem thêm [RUNBOOK.md](./RUNBOOK.md) cho quy trình phát triển feature chi tiết.

---

## 1. Tổng quan hệ thống

**Mini Wiki** — ứng dụng Node.js/Express + SQLite (better-sqlite3), đóng gói bằng Docker, phục vụ sau reverse proxy Caddy, và triển khai tự động lên VPS qua GitHub Actions.

```
GitHub push (main) → CI test → build & push image (GHCR) → SSH deploy → VPS
                                                                          │
                                                    Caddy (:80) → wiki container (:3000) → SQLite (volume)
```

---

## 2. First Principles — Nguyên lý nền tảng của codebase

### 2.1 Application layer (`src/`)
- `server.ts` — entrypoint, chỉ lo việc bind host/port và khởi động HTTP server.
- `app.ts` — Express app, chứa toàn bộ route handler.
- `db.ts` — lớp truy cập dữ liệu, đóng gói mọi câu SQL và schema.

Nguyên lý: **tách bootstrapping (server) khỏi HTTP layer (app) khỏi persistence (db)**. Nhờ vậy `app.ts` có thể được import và test độc lập mà không cần một network listener thật — xem `test/health.test.ts`, nó gọi `app.listen(0, ...)` trực tiếp trong test.

### 2.2 Build — Dockerfile multi-stage
```
dev (deps + build tools) → build (tsc + prune dev deps) → runtime (clean base + dist + prod deps)
```
- Stage `dev` cài `python3/make/g++` vì `better-sqlite3` cần compile native addon (node-gyp).
- Stage `runtime` chỉ copy `node_modules` (đã prune) + `dist`, chạy bằng user non-root `node`.

Nguyên lý: **image production tối giản** — không có source TypeScript, không có toolchain build → giảm kích thước & bề mặt tấn công. Cùng một Dockerfile phục vụ cả dev (`target: dev`, dùng trong `compose.override.yaml`) lẫn production (target mặc định `runtime`).

### 2.3 Compose — nguyên lý orchestration
- 2 service: `wiki` (app) + `caddy` (reverse proxy).
- `wiki` **không** expose port ra host (`ports` bị comment, chỉ có `expose`) — mọi traffic bắt buộc đi qua Caddy, tập trung TLS/logging tại một điểm duy nhất.
- Volume `wiki-data` giữ file SQLite sống sót qua các lần recreate container.
- Healthcheck gọi thẳng `/health` bằng chính Node runtime (`node -e "fetch(...)"`) — không cần cài `curl`/`wget` vào image production.
- `compose.override.yaml` (không commit, có file `.example`) dùng để bật hot-reload cục bộ mà không đụng vào `compose.yaml` gốc — tách biệt config dev/prod theo cơ chế base + override chuẩn của Docker Compose.

### 2.4 Reverse Proxy — `Caddyfile`
- `auto_https off`: tắt vì hiện chưa gắn domain thật. Khi có domain, cần bật lại và mở port 443 (xem mục 3.4).
- `reverse_proxy wiki:3000`: Caddy resolve tên service `wiki` qua Docker DNS nội bộ trong network `app`, không cần biết IP container.

### 2.5 CI/CD Pipeline (`.github/workflows/pipeline.yml`)
3 job tuần tự, job sau chỉ chạy khi job trước pass:

1. **`test`** — chạy trên mọi push/PR vào `main`: `npm ci` + `npm run verify` (build TypeScript + test suite).
2. **`build-and-publish`** — chỉ khi push trực tiếp vào `main` (không chạy trên PR): build Docker image, gắn tag bằng `GITHUB_SHA`, push lên GHCR.
3. **`deploy`** — SSH vào VPS, `scp` `compose.yaml` + `Caddyfile` mới nhất lên `~/wiki-app`, rồi chạy `scripts/deploy.sh` qua SSH với `IMAGE_TAG=$GITHUB_SHA`.

Nguyên lý quan trọng:
- **Immutable artifact**: tag theo SHA thay vì `latest` → mỗi lần deploy biết chính xác build nào đang chạy → dễ audit và rollback.
- **Config đi theo Git**: `compose.yaml`/`Caddyfile` luôn được đồng bộ từ repo lên VPS ở mỗi lần deploy — VPS không tự sửa tay các file này.
- **Build tách khỏi deploy**: build chạy trên GitHub runner; VPS chỉ `pull` image có sẵn, không build trên production → deploy nhanh, VPS không cần toolchain build.

### 2.6 `scripts/deploy.sh`
- Bắt buộc `IMAGE_TAG` (fail-fast nếu thiếu) — tránh deploy nhầm tag rỗng.
- Login GHCR tùy chọn nếu repo là private (`REGISTRY_USER`/`REGISTRY_TOKEN`).
- `docker compose pull` rồi `docker compose up -d` — Compose tự so sánh image tag mới với container đang chạy để quyết định recreate.

---

## 3. Hướng dẫn Deploy

### 3.1 Deploy tự động (khuyến nghị — qua CI/CD)
Chỉ cần merge/push vào `main`, pipeline tự làm mọi việc. Cần setup một lần trước đó:

**Trên VPS:**
1. Cài Docker + Docker Compose plugin.
2. Tạo thư mục `~/wiki-app` (trong home của user SSH dùng để deploy — **không** dùng `/opt`, vì user đó không có quyền ghi vào `/opt` trừ khi cấu hình sudo, và pipeline không chạy `sudo`).
3. Tạo file `.env` tại `~/wiki-app/.env` (copy từ `.env.example`, chỉnh `SERVER_NAME` theo domain/IP thật).
4. Đảm bảo user SSH dùng để deploy có quyền chạy Docker (thuộc group `docker`).

**Trên GitHub repo → Settings → Secrets and variables → Actions**, cần khai báo:

| Secret | Mục đích |
|---|---|
| `VPS_SSH_KEY` | Private key SSH để đăng nhập VPS |
| `VPS_KNOWN_HOSTS` | Fingerprint VPS (lấy bằng `ssh-keyscan`) để tránh prompt xác nhận |
| `VPS_HOST` | IP/domain của VPS |
| `VPS_USER` | User SSH trên VPS |
| `VPS_PORT` | Cổng SSH |

(`GITHUB_TOKEN` dùng để push GHCR đã tự có sẵn, không cần khai báo.)

### 3.2 Deploy thủ công trên VPS (chạy tay hoặc rollback)
```bash
cd ~/wiki-app
export IMAGE_TAG=<git-sha-muon-deploy>   # bắt buộc
export IMAGE_REPO=whisky81/wiki           # optional, đã có giá trị mặc định đúng
bash scripts/deploy.sh
```
**Rollback**: chỉ cần đổi `IMAGE_TAG` về SHA của commit ổn định trước đó — image đó vẫn còn trên GHCR vì mọi lần build đều được push, không bị xoá tự động.

### 3.3 Kiểm tra sau khi deploy
```bash
docker compose ps
docker compose logs -f wiki
curl http://<VPS_HOST>/health
```
Kỳ vọng: `{"status":"ok","database":"ok"}`

### 3.4 Khi có domain thật (bật HTTPS)
Trong `Caddyfile`: xóa dòng `auto_https off`, đổi block sang domain thật, ví dụ:
```
example.com {
  reverse_proxy wiki:3000
}
```
Trong `compose.yaml`: bỏ comment dòng `443:443` trong phần `ports` của service `caddy`.

---

## 4. Hướng dẫn sử dụng

### 4.1 Chạy local nhanh (Node trực tiếp)
```bash
npm install
cp .env.example .env
npm run dev      # http://localhost:3000, hot reload qua tsx watch
npm run test     # chạy test suite (node --test)
npm run verify   # build + test — bắt buộc chạy trước khi commit
```

### 4.2 Chạy qua Docker Compose
```bash
# Dev với hot-reload trong container
cp compose.override.yaml.example compose.override.yaml
docker compose up

# Test đúng image production trước khi push
docker compose -f compose.yaml up --build
```
Quy trình phát triển feature đầy đủ (branch, PR, quality gate...) xem tại [RUNBOOK.md](./RUNBOOK.md).

### 4.3 Các endpoint hiện có

| Method | Path | Chức năng |
|---|---|---|
| GET | `/` | Trang chủ — danh sách wiki page + form tạo mới |
| POST | `/pages` | Tạo page mới (`title`, `content`) |
| GET | `/health` | Health check, dùng bởi Docker healthcheck |
| GET | `/deploy` | Trả JSON tĩnh xác nhận app đang chạy sau deploy |
| GET | `/crash` | Cố ý gọi `process.exit(1)` — dùng để kiểm tra khả năng tự phục hồi (restart policy `unless-stopped`) |

> ⚠️ `/crash` và `/deploy` hiện không có xác thực và có thể bị gọi công khai. Nếu đây không phải chủ đích, nên giới hạn truy cập (auth, chặn qua Caddy, hoặc xóa) trước khi phục vụ production thật.

### 4.4 Biến môi trường (`.env`)

| Biến | Ý nghĩa | Ghi chú |
|---|---|---|
| `DB_PATH` | Đường dẫn file SQLite | Mặc định `/app/data/wiki.db` trong container |
| `FORWARD_PORT` | Cổng host map ra ngoài nếu bật lại `ports` trong compose | Hiện Caddy đảm nhiệm cổng 80 thay thế |
| `SERVER_NAME` | Domain/host Caddy lắng nghe | Mặc định `localhost` |
| `PORT` | Không có tác dụng thực tế hiện tại | Xem lưu ý bên dưới |

> ⚠️ Phát hiện khi đọc code: `src/server.ts` có dòng đọc `PORT` bị comment, và đang gọi `app.listen(3000, ...)` với cổng hard-code. Nghĩa là đổi `PORT` trong `.env` **không** ảnh hưởng tới cổng thực tế — server luôn lắng nghe ở `3000` bên trong container.
