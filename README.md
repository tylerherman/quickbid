# Quick Bid Scanner

Upload construction plan PDFs, classify pages with Claude Vision, and extract structured bid data.

## Prerequisites

- Python 3.11+
- Node.js 18+
- Poppler (for PDF to image conversion)
- Anthropic API key

### Install Poppler

**Mac:**
```bash
brew install poppler
```

**Windows:**
1. Download from https://github.com/ossamamehmood/Poppler-windows/releases
2. Extract to `C:\poppler`
3. Add `C:\poppler\Library\bin` to your system PATH

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install poppler-utils
```

## Setup

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create a `.env` file in `backend/`:
```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Start the server:
```bash
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs at http://localhost:5173 and proxies API requests to the backend at port 8000.

## Usage

1. Open http://localhost:5173
2. Upload a construction plan PDF
3. Review page classifications — Claude identifies each page type
4. Click "Extract Data" to pull structured fields from priority pages
5. Review and edit extracted data, then save

Saved scans go to `backend/scans/` as timestamped JSON files. Raw Claude API responses are also saved there for debugging.

## Deploying to Railway

### 1. Push to GitHub

```bash
cd quick-bid-scanner
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-user/quick-bid-scanner.git
git push -u origin main
```

### 2. Create a Railway project

Go to [railway.app](https://railway.app) and create a new project.

### 3. Add the backend service

- Click "New Service" → "GitHub Repo" → select your repo
- Set **Root Directory** to `/backend`
- Add environment variables:
  - `ANTHROPIC_API_KEY` — your Anthropic API key
  - `ALLOWED_ORIGINS` — the frontend Railway URL once deployed (e.g. `https://quick-bid-scanner-frontend-production.up.railway.app`)
- Railway will detect the Dockerfile and build automatically

### 4. Add the frontend service

- Click "New Service" → "GitHub Repo" → select the same repo
- Set **Root Directory** to `/frontend`
- Add environment variables:
  - `VITE_API_URL` — the backend Railway URL (e.g. `https://quick-bid-scanner-backend-production.up.railway.app`)
- Railway will detect the Dockerfile and build automatically

### 5. Deploy

- Deploy both services
- Once the backend is live, copy its public URL and set it as `VITE_API_URL` on the frontend service
- Once the frontend is live, copy its public URL and set it as `ALLOWED_ORIGINS` on the backend service
- Redeploy both services so the URLs take effect

### Known limitations

- **Ephemeral storage:** The `scans/` and `uploads/` directories live on Railway's filesystem, which resets on every redeploy. Saved scans and uploaded PDFs will not persist across deployments. For a production setup, use an external storage service (S3, Cloudflare R2, etc.).
