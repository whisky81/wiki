# Milestone 8 — Release Engineering: Immutable Artifact & Registry

Tài liệu này ghi lại toàn bộ thay đổi kiến trúc và hướng dẫn thiết lập chi tiết để đưa ứng dụng lên môi trường production theo mô hình **Immutable Artifact & Container Registry**.

---

## 1. Tổng quan thay đổi kiến trúc

### Trước đây (Milestone 7):
```text
GitHub Push ──► VPS SSH ──► git pull ──► docker compose build ──► Run
```
* **Nhược điểm:** VPS phải cài đặt build tools, tốn tài nguyên và thời gian build trên server; môi trường build giữa CI và VPS có thể bị lệch; rollback phức tạp (phải reset git và build lại).

### Bây giờ (Milestone 8):
```text
GitHub Push ──► CI (Test) ──► CI (Docker build) ──► Push GHCR (Image Tag = Commit SHA)
                                                           │
                                                           ▼
VPS ◄── SSH (IMAGE_TAG) ── docker compose pull ── docker compose up (Chạy exact artifact)
```
* **Ưu điểm:**
  - **Build Once, Deploy Anywhere:** Image chỉ build 1 lần trên CI runner, VPS chỉ là runtime machine.
  - **Release Identity:** Mỗi commit SHA tương ứng với 1 image tag bất biến (`ghcr.io/whisky81/wiki:<commit-sha>`).
  - **Rollback tức thì:** Rollback chỉ đơn giản là đổi `IMAGE_TAG` sang SHA cũ và chạy lại `docker compose up -d`, không cần build lại.

---

## 2. Chi tiết các file đã thay đổi trong Repo

1. **[`compose.yaml`](file:///home/whiskyrei/wkwk/compose.yaml)**:
   - Chuyển từ `build: .` sang dùng image trực tiếp từ GHCR:
     ```yaml
     image: ghcr.io/${IMAGE_REPO:-whisky81/wiki}:${IMAGE_TAG}
     ```
   - Tách biệt giữa **Runtime Configuration** (`.env` chứa `PORT`, `DB_PATH`, `FORWARD_PORT`) và **Release Identity** (`IMAGE_TAG`).

2. **[`scripts/deploy.sh`](file:///home/whiskyrei/wkwk/scripts/deploy.sh)**:
   - Xóa bỏ hoàn toàn `git fetch` và `docker compose build`.
   - Nhận biến `IMAGE_TAG` từ CI, pull đúng image từ GHCR và kích hoạt container mới.

3. **[`.github/workflows/pipeline.yml`](file:///home/whiskyrei/wkwk/.github/workflows/pipeline.yml)**:
   - Thêm quyền `packages: write` cho `GITHUB_TOKEN`.
   - Pipeline gồm 3 stages:
     1. **`test`**: Chạy `npm ci` & `npm run verify` (tsc + unit test).
     2. **`build-and-publish`**: Đăng nhập GHCR bằng `GITHUB_TOKEN`, build Docker image gắn tag `${GITHUB_SHA}`, và push lên GHCR.
     3. **`deploy`**: SSH vào VPS truyền `IMAGE_TAG="${GITHUB_SHA}"` và thực thi script `deploy.sh`.

---

## 3. Hướng dẫn thiết lập Secrets & Môi trường để chạy Production

### A. Thiết lập trên GitHub Repository (GitHub Actions Secrets)

Vào repository trên GitHub: **Settings** ➔ **Secrets and variables** ➔ **Actions** ➔ **New repository secret**.

Đảm bảo bạn đã cấu hình đủ 5 secrets sau:

| Tên Secret | Ý nghĩa | Ví dụ / Hướng dẫn copy-paste |
| :--- | :--- | :--- |
| `VPS_HOST` | Địa chỉ IP hoặc domain của VPS | `123.45.67.89` |
| `VPS_USER` | SSH user trên VPS | `ubuntu` hoặc `root` hoặc `deploy` |
| `VPS_PORT` | Cổng SSH của VPS | `22` (hoặc custom SSH port) |
| `VPS_SSH_KEY` | Private SSH Key (ed25519 hoặc rsa) để CI ssh vào VPS | Nội dung file `~/.ssh/id_ed25519` (bắt đầu bằng `-----BEGIN OPENSSH PRIVATE KEY-----`) |
| `VPS_KNOWN_HOSTS`| Public key hash của host VPS để chống MITM | Output của lệnh: `ssh-keyscan -p <PORT> <VPS_HOST>` |

> [!NOTE]
> `GITHUB_TOKEN` là token mặc định do GitHub Actions tự tạo và cấp sẵn trong workflow. Bạn **không cần** tự tạo `GITHUB_TOKEN` trên GitHub secrets.

---

### B. Thiết lập trên VPS (Server Production)

Trên VPS, tại thư mục deploy (mặc định trong script là `/opt/wiki-app`):

#### 1. Tạo file `.env` chứa Runtime Config
```bash
cat << 'EOF' > /opt/wiki-app/.env
PORT=3000
DB_PATH=/app/data/wiki.db
FORWARD_PORT=9999
EOF
```

#### 2. Phân quyền và tạo thư mục
```bash
mkdir -p /opt/wiki-app/data
```

#### 3. Cấu hình quyền truy cập GitHub Container Registry (GHCR) trên VPS
- **Nếu repo là Public:** GHCR image là public, VPS có thể `docker pull` trực tiếp không cần login.
- **Nếu repo là Private:** Bạn cần login Docker vào GHCR trên VPS 1 lần:
  1. Tạo **Personal Access Token (Classic)** trên GitHub (`Settings` ➔ `Developer settings` ➔ `Personal access tokens` ➔ `Tokens (classic)`), chọn quyền `read:packages`.
  2. Chạy lệnh trên VPS:
     ```bash
     echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
     ```

#### 4. File `compose.yaml` trên VPS
Đảm bảo file [`compose.yaml`](file:///home/whiskyrei/wkwk/compose.yaml) đã có sẵn tại `/opt/wiki-app/compose.yaml`.

---

## 4. Cách Rollback trên Production khi có sự cố

Nếu release mới bị lỗi, chỉ cần SSH vào VPS và đổi `IMAGE_TAG` sang commit SHA cũ đã kiểm chứng:

```bash
cd /opt/wiki-app

# 1. Đặt tag của phiên bản chạy tốt trước đó
export IMAGE_TAG=commit_sha_truoc_do

# 2. Pull artifact cũ từ registry
docker compose pull wiki

# 3. Chạy lại container với image cũ
docker compose up -d wiki

# 4. Kiểm tra sức khỏe container
curl -fail http://127.0.0.1:9999/health
```
*(Quá trình rollback diễn ra trong vài giây mà không cần biên dịch hay kéo source code lại).*
