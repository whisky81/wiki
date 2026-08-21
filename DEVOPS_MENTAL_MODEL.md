# DevOps Mental Model & First Principles Deep Dive

> **"DevOps không phải là công cụ (tools) hay cú pháp (syntax). DevOps là nghệ thuật quản lý Trạng thái (State), Ranh giới tin cậy (Trust Boundaries), và Vòng đời phát triển phần mềm (Software Lifecycle) từ mã nguồn tới môi trường thực thi."**

Tài liệu này phân tích toàn bộ kiến trúc và cấu hình DevOps trong codebase `wkwk` dựa trên **First Principles (Nguyên lý nền tảng)** của kỹ thuật phần mềm và hệ thống phân tán, thay vì chỉ giải thích cú pháp bề mặt.

---

## 1. Bản đồ Tư duy Tổng quan (The Big Picture)

```
[ Developer Machine ]
        │  git push
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Continuous Integration & Quality Gate (GitHub Actions: 'test')       │
│    - Deterministic dependency resolution (npm ci)                      │
│    - Static Type Verification (tsc) & Dynamic Contract (node:test)     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ (Pass Gates)
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. Immutable Packaging (GitHub Actions: 'build-and-publish')           │
│    - Multi-stage Docker build (C++ toolchain vs Slim runtime)          │
│    - Layer Caching Physics (package.json vs Source Code)               │
│    - Content Addressing: Gắn tag bất biến ${GITHUB_SHA}                │
│    - Push to GitHub Container Registry (ghcr.io)                       │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ (SSH stream pipe)
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Continuous Delivery & Runtime Convergence (VPS Host via deploy.sh)  │
│    - Host Key Verification (Chống Man-in-the-Middle)                   │
│    - Ephemeral Remote Execution (Không clone source trên VPS)          │
│    - State vs Artifact decoupling (Docker Named Volume)                │
│    - In-process native Healthcheck (Node.js runtime fetch)             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Containerization: Đóng gói Tính toán & Môi trường Thực thi

### File: `Dockerfile` & `.dockerignore`

#### A. Multi-Stage Build: Phân tách Môi trường Biên dịch và Môi trường Thực thi
* **Bản chất vấn đề:** Ứng dụng Node.js viết bằng TypeScript và sử dụng `better-sqlite3` (một native C++ addon gắn trực tiếp với SQLite engine qua node-gyp). Để biên dịch C++ addon, hệ điều hành cần `python3`, `make`, `g++`, và toàn bộ `devDependencies` (`typescript`, `@types/*`).
* **Tại sao không dùng 1 stage duy nhất?**
  1. **Tấn công bề mặt (Attack Surface):** Một image chứa sẵn compiler (`g++`, `make`) và shell script phức tạp sẽ tạo điều kiện cho kẻ tấn công thực thi mã độc hoặc leo thang đặc quyền (privilege escalation) nếu có lỗ hổng RCE.
  2. **Kích thước Image (Payload Size):** Compiler và dev dependencies làm phình image lên hàng trăm MB hoặc GB, làm chậm quá trình pull qua mạng trong CI/CD.
* **Giải pháp First Principle trong code:**
  - **Stage 1 (`build`):**
    ```dockerfile
    FROM node:22-bookworm-slim AS build
    RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ && rm -rf /var/lib/apt/lists/*
    RUN npm ci
    RUN npm run build
    RUN npm prune --omit=dev
    ```
    Stage này đóng vai trò là một "nhà máy tạm thời", cài toolchain, biên dịch TypeScript sang JavaScript (`dist/`), biên dịch C++ addon, rồi loại bỏ devDependencies (`npm prune --omit=dev`).
  - **Stage 2 (`runtime`):**
    ```dockerfile
    FROM node:22-bookworm-slim AS runtime
    COPY --from=build /app/node_modules ./node_modules
    COPY --from=build /app/dist ./dist
    ```
    Chỉ copy sản phẩm cuối cùng (compiled code + production dependencies). Image runtime hoàn toàn không chứa compiler hay source TypeScript.

#### B. Cơ học Docker Layer Caching (The Physics of Image Layers)
* **Nguyên lý:** Docker build theo cơ chế Cache từng layer từ trên xuống dưới. Nếu layer N thay đổi, tất cả các layer từ N+1 trở xuống đều bị vô hiệu hóa cache (cache invalidation).
* **Ứng dụng:**
  ```dockerfile
  # 1. Layer ít biến động nhất (Dependencies metadata)
  COPY package*.json ./
  RUN npm ci

  # 2. Layer biến động thường xuyên (Source code)
  COPY tsconfig.json ./
  COPY src ./src
  COPY test ./test
  RUN npm run build
  ```
  Dependency (`package.json`) ít khi đổi so với `src/`. Bằng cách copy `package*.json` và chạy `npm ci` trước, khi lập trình viên thay đổi code trong `src/`, Docker sẽ dùng lại 100% cache của bước tải thư viện, giảm thời gian build từ hàng phút xuống vài giây.

#### C. Nguyên lý Đặc quyền Tối thiểu (Principle of Least Privilege)
* **Nguyên lý:** Mặc định trong Linux container, tiến trình chạy dưới quyền `root` (UID 0). Nếu ứng dụng bị khai thác, kẻ tấn công có quyền root trong namespace của container.
* **Ứng dụng:**
  ```dockerfile
  RUN mkdir -p /app/data && chown -R node:node /app
  USER node
  ```
  Chuyển tiến trình sang user không đặc quyền (`node` - UID 1000). Thư mục `/app/data` được cấp quyền trước để user `node` có thể đọc/ghi SQLite database.

#### D. Kiểm soát Bối cảnh Build (`.dockerignore`)
* **Nguyên lý:** Khi chạy `docker build`, toàn bộ thư mục hiện tại được nén lại thành *Build Context* gửi cho Docker daemon.
* **Tại sao cần `.dockerignore`?**
  - Tránh đưa `node_modules` từ máy host (vốn có thể được build trên macOS hoặc kiến trúc CPU khác) vào container Linux.
  - Tránh leak dữ liệu cục bộ (`data/*.db`, file bí mật `.env`, `.git`).
  - Giữ build context cực nhỏ (vài KB), tăng tốc độ truyền context.

---

## 3. Quản lý Trạng thái và Cấu hình Thực thi (State & Runtime Config)

### File: `compose.yaml`, `.env`, `src/db.ts`

```
┌─────────────────────────────────────────────────────────────┐
│ Container Lifecycle (Ephemeral - Có thể xóa bỏ & tạo lại)   │
│  ┌────────────────────────┐                                 │
│  │   Node.js App Process   │                                 │
│  └───────────┬────────────┘                                 │
└──────────────┼──────────────────────────────────────────────┘
               │ I/O Read/Write (/app/data/wiki.db)
               ▼
┌─────────────────────────────────────────────────────────────┐
│ Named Volume (Persistent Storage: 'wiki-data')              │
│  (Lưu trữ an toàn trên Host OS, sống sót qua các lần deploy)│
└─────────────────────────────────────────────────────────────┘
```

#### A. Phân tách ranh giới: Stateless Compute vs Stateful Storage
* **First Principle:** Một container phải có tính chất **Ephemeral (Phù du)** — có thể bị kill, restart hoặc thay thế bằng phiên bản mới bất kỳ lúc nào mà không gây mất mát dữ liệu kinh doanh.
* **Vấn đề với SQLite:** SQLite không phải là một service database độc lập chạy qua mạng như PostgreSQL hay MySQL; SQLite là một file nằm trực tiếp trên ổ cứng.
* **Giải pháp trong `compose.yaml`:**
  ```yaml
  volumes:
    - wiki-data:/app/data
  ```
  Mount một Docker Named Volume (`wiki-data`) vào `/app/data`. Khi cập nhật phiên bản mới (kéo image mới và kill container cũ), container mới mount lại volume `wiki-data` và tiếp tục đọc dữ liệu SQLite nguyên vẹn.

#### B. Phân tách ranh giới: Release Identity vs Runtime Configuration
* **First Principle (12-Factor App - III. Config):** Code và Image phải độc lập hoàn toàn với môi trường chạy (dev, staging, production).
* **Kiến trúc trong codebase:**
  1. **Release Identity (`IMAGE_TAG`):** Được truyền động từ bên ngoài (thường là Git commit SHA) để xác định chính xác phiên bản mã nguồn.
     ```yaml
     image: ghcr.io/${IMAGE_REPO:-whisky81/wiki}:${IMAGE_TAG}
     ```
  2. **Runtime Configuration (`.env`):** Chứa các thông số phụ thuộc hạ tầng (port forward, đường dẫn DB). File này nằm riêng trên VPS và không bao giờ commit vào Git.
     ```yaml
     env_file:
       - .env
     ```

#### C. Zero-Dependency Healthcheck: Tận dụng Năng lực Sẵn có của Runtime
* **Vấn đề thường gặp:** Nhiều người viết healthcheck bằng `curl` hoặc `wget`:
  `test: ["CMD", "curl", "-f", "http://localhost:3000/health"]`
  Nhưng trong các base image tối giản (`slim`, `distroless`), `curl` **không hề tồn tại**, khiến healthcheck lỗi hoặc buộc phải cài thêm package thừa.
* **Giải pháp First Principle trong `compose.yaml`:**
  ```yaml
  healthcheck:
    test:
      [
        "CMD",
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
      ]
    interval: 30s
    timeout: 5s
    retries: 3
    start_period: 10s
  ```
  Sử dụng chính engine `node` (đã hỗ trợ native `fetch` từ Node 18+) để kiểm tra endpoint `/health`. Điều này đạt được 3 mục tiêu:
  1. Không cần cài thêm bất kỳ binary ngoại lai nào vào runtime image.
  2. Đánh giá tính toàn vẹn sâu (Deep Healthcheck): Endpoint `/health` trong [`src/app.ts`](file:///home/whiskyrei/wkwk/src/app.ts) gọi hàm `checkDatabase()` (`SELECT 1`), chứng minh cả HTTP server lẫn SQLite connection đều hoạt động bình thường.
  3. Docker daemon tự động gắn nhãn container là `healthy` hoặc `unhealthy`, phục vụ tự phục hồi (Self-Healing).

---

## 4. Tự động hóa Pipeline & Gateways (CI/CD Quality Gates)

### File: `.github/workflows/pipeline.yml`

Quy trình phát hành được chia làm 3 pha tuần tự với các "chốt chặn chất lượng" (Quality Gates) nghiêm ngặt:

```
[ Push to main ]
       │
       ▼
┌──────────────┐   Fail
│  Job: test   │ ───────► (Dừng toàn bộ Pipeline - Không tạo Image)
└──────┬───────┘
       │ Pass
       ▼
┌───────────────────────────┐   Fail
│  Job: build-and-publish   │ ───────► (Dừng Pipeline - Không chạm vào VPS)
└──────────────┬────────────┘
       │ Pass
       ▼
┌───────────────────────────┐
│  Job: deploy              │ ───────► (VPS cập nhật sang SHA mới an toàn)
└───────────────────────────┘
```

#### A. Gate 1: Test & Contract Verification
* **First Principle:** "Đừng bao giờ đóng gói mã nguồn bị hỏng."
* Pipeline chạy `npm ci` (đảm bảo tính tất định từ `package-lock.json`), sau đó chạy `npm run verify` (`tsc` để kiểm tra kiểu tĩnh + `node --test` để kiểm tra hợp đồng API).
* Nếu có lỗi cú pháp hoặc unit test gãy, pipeline dừng ngay lập tức tại runner của GitHub, không tiêu tốn tài nguyên build Docker hay ảnh hưởng tới production.

#### B. Gate 2: Immutable Artifact & GHCR Publishing
* **First Principle (Immutable Infrastructure):** Một khi artifact (Docker Image) đã được build và verify, nó **không bao giờ được thay đổi**.
* **Tại sao không dùng tag `:latest`?** Tag `:latest` là mutable pointer (con trỏ có thể trỏ tới bất kỳ đâu). Dùng `:latest` sẽ làm mất khả năng truy vết và khiến việc rollback trở nên không thể đoán trước.
* **Giải pháp:**
  ```yaml
  IMAGE_LOWER=$(echo "$IMAGE" | tr '[:upper:]' '[:lower:]')
  docker build -t "$IMAGE_LOWER:${GITHUB_SHA}" .
  docker push "$IMAGE_LOWER:${GITHUB_SHA}"
  ```
  Image được gán tag chính là `${GITHUB_SHA}` (mã hash cryptographic của commit). Mỗi build tạo ra một artifact duy nhất, có tính bất biến và liên kết trực tiếp 1-1 với lịch sử Git.

#### C. Gate 3: Secure SSH Authentication & MITM Prevention
* **First Principle (Zero Trust & Secure Enclave):** CI runner là một môi trường tạm thời (ephemeral runner). Mọi giao tiếp với VPS production phải được mã hóa và xác thực 2 chiều.
* **Cơ chế xác thực:**
  ```yaml
  printf '%s\n' "$VPS_SSH_KEY" > ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
  printf '%s\n' "$VPS_KNOWN_HOSTS" > ~/.ssh/known_hosts
  ```
  1. `VPS_SSH_KEY`: Khóa riêng tư xác thực CI runner với VPS.
  2. `VPS_KNOWN_HOSTS`: Public key fingerprint của VPS được ghim sẵn. Điều này chặn đứng hoàn toàn nguy cơ tấn công **Man-in-the-Middle (MITM)** nếu DNS hoặc IP bị giả mạo.

---

## 5. Cơ chế Triển khai Thực thi (Deployment Strategy)

### File: `scripts/deploy.sh` & SSH Invocations

#### A. Kiến trúc Stream Execution: Không lưu trữ mã nguồn trên VPS
* **Mô hình cũ (Anti-pattern):**
  SSH vào VPS ➔ `git pull` ➔ `docker compose build`.
  *Hệ quả:* VPS trở thành máy build, tốn CPU/RAM, cần cài git/credentials trên VPS, xung đột file git (dirty working directory), và rollback rất chậm.
* **Mô hình mới trong codebase (Artifact-based Deployment):**
  ```yaml
  ssh -p "$VPS_PORT" "$VPS_USER@$VPS_HOST" \
    "IMAGE_TAG='${GITHUB_SHA}' IMAGE_REPO='$(echo "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')' bash -s" < scripts/deploy.sh
  ```
  *Bản chất kỹ thuật:* File [`scripts/deploy.sh`](file:///home/whiskyrei/wkwk/scripts/deploy.sh) được truyền qua **chuỗi luồng tiêu chuẩn (Standard Input `stdin`)** của lệnh SSH vào tiến trình `bash -s` trên VPS.
  - Trên VPS **không cần clone source code repository**.
  - VPS chỉ cần duy nhất 2 file: `compose.yaml` và `.env`.

#### B. Fail-Fast Execution trong Shell Script
* Trong [`scripts/deploy.sh`](file:///home/whiskyrei/wkwk/scripts/deploy.sh):
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  ```
  - `-e` (errexit): Thoát ngay nếu bất kỳ lệnh nào trả về exit code khác 0.
  - `-u` (nounset): Báo lỗi và thoát nếu sử dụng biến chưa được định nghĩa (ví dụ quên truyền `IMAGE_TAG`).
  - `-o pipefail`: Nếu một pipeline (ví dụ `a | b | c`) có bước lỗi, toàn bộ lệnh được xem là lỗi (không bị nuốt lỗi bởi bước cuối).

#### C. Quy trình Hội tụ Trạng thái (Runtime Convergence)
1. `docker compose pull wiki`: Tải trước toàn bộ các layers của image mới từ GHCR về VPS trong khi container cũ vẫn đang phục vụ traffic (giảm thiểu thời gian gián đoạn).
2. `docker compose up -d wiki`: So sánh cấu hình hiện tại với cấu hình mong muốn (Desired State). Nhận thấy `IMAGE_TAG` đã đổi, Docker daemon sẽ:
   - Dừng container cũ.
   - Tạo container mới từ image SHA mới.
   - Gắn lại named volume `wiki-data`.
   - Khởi động container và bắt đầu chu kỳ healthcheck.
3. `docker compose ps`: Xác nhận trạng thái running của service.

#### D. Cơ chế Rollback Tức thì (Zero-Build Rollback)
Nếu commit mới phát sinh lỗi nghiệp vụ trên production, thao tác rollback không cần build lại:
```bash
export IMAGE_TAG=<commit_sha_on_dinh_truoc_do>
docker compose pull wiki
docker compose up -d wiki
```
Toàn bộ quá trình phục hồi diễn ra trong khoảng 2-5 giây vì image cũ đã từng được pull hoặc có thể pull lại trực tiếp từ GHCR.

---

## 6. Bảng Tổng kết Mental Models

| Khái niệm DevOps | Tư duy Bề mặt (Học vẹt) | Tư duy First Principles (Bản chất hệ thống) | Hiện thực trong Codebase |
| :--- | :--- | :--- | :--- |
| **Multi-stage Docker** | "Viết 2 lần FROM cho ngắn file" | Phân tách không gian build (đầy đủ compilers/tools) khỏi không gian runtime (tối thiểu hóa bề mặt tấn công & kích thước truyền tải). | [`Dockerfile:L1-L47`](file:///home/whiskyrei/wkwk/Dockerfile#L1-L47) |
| **Layer Caching** | "Copy file nào trước cũng được" | Tối ưu đồ thị tính toán theo tần suất biến động của dữ liệu (metadata dependencies ít đổi xếp trước, source code đổi liên tục xếp sau). | [`Dockerfile:L5-L19`](file:///home/whiskyrei/wkwk/Dockerfile#L5-L19) |
| **Non-root User** | "Thêm dòng `USER node` cho đủ bài" | Phòng thủ chiều sâu (Defense-in-depth): Giới hạn phạm vi ảnh hưởng khi xảy ra lỗi bảo mật cấp ứng dụng trong Linux namespace. | [`Dockerfile:L41-L43`](file:///home/whiskyrei/wkwk/Dockerfile#L41-L43) |
| **Image Tagging** | "Dùng tag `:latest` cho tiện" | Định danh phiên bản bất biến (Content Addressing): Gắn chặt 1 artifact nhị phân với 1 trạng thái mã nguồn duy nhất (`${GITHUB_SHA}`). | [`.github/workflows/pipeline.yml:L57`](file:///home/whiskyrei/wkwk/.github/workflows/pipeline.yml#L57) |
| **Healthcheck** | "Cài curl vào để gọi API" | Tận dụng công cụ nội tại của môi trường thực thi (Node.js runtime) để kiểm tra tính toàn vẹn hệ thống mà không tạo dependency rác. | [`compose.yaml:L15-L26`](file:///home/whiskyrei/wkwk/compose.yaml#L15-L26) |
| **State Persistence** | "Lưu DB vào ổ cứng container" | Phân biệt ranh giới giữa Computational Lifecycle (phù du, thay thế liên tục) và Data Persistence (bền vững qua Volume). | [`compose.yaml:L10-L11`](file:///home/whiskyrei/wkwk/compose.yaml#L10-L11) |
| **Remote Deploy** | "SSH vào server rồi git pull build" | Server chỉ đóng vai trò Worker Runtime; toàn bộ việc đóng gói được trừu tượng hóa trên CI, đẩy script thực thi qua SSH Stream. | [`.github/workflows/pipeline.yml:L87-L90`](file:///home/whiskyrei/wkwk/.github/workflows/pipeline.yml#L87-L90) & [`scripts/deploy.sh`](file:///home/whiskyrei/wkwk/scripts/deploy.sh) |
