import json
import logging
import os
import shutil
import traceback
import uuid
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import scanner

logger = logging.getLogger("uvicorn.error")

load_dotenv()

app = FastAPI(title="Quick Bid Scanner")

allowed_origins = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173")
origins = [o.strip() for o in allowed_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

# In-memory store: upload_id -> {path, filename, classifications}
uploads: dict[str, dict] = {}


@app.get("/")
def root():
    return {"status": "ok"}


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted")

    upload_id = uuid.uuid4().hex[:12]
    save_path = UPLOADS_DIR / f"{upload_id}.pdf"

    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        result = scanner.classify_pages(str(save_path), file.filename)
    except anthropic.APIStatusError as e:
        logger.error("Anthropic API error: %s", e.message)
        raise HTTPException(e.status_code, f"Anthropic API error: {e.message}")
    except Exception as e:
        logger.error("Classification failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Classification failed: {str(e)}")

    uploads[upload_id] = {
        "path": str(save_path),
        "filename": file.filename,
        "classifications": result["classifications"],
    }

    return {
        "upload_id": upload_id,
        "filename": file.filename,
        **result,
    }


class ExtractRequest(BaseModel):
    upload_id: str
    page_selections: list[dict]


@app.post("/extract")
async def extract_data(req: ExtractRequest):
    if req.upload_id not in uploads:
        raise HTTPException(404, "Upload not found")

    info = uploads[req.upload_id]
    try:
        result = scanner.extract_fields(
            info["path"], info["filename"], req.page_selections
        )
    except anthropic.APIStatusError as e:
        logger.error("Anthropic API error: %s", e.message)
        raise HTTPException(e.status_code, f"Anthropic API error: {e.message}")
    except Exception as e:
        logger.error("Extraction failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Extraction failed: {str(e)}")

    return {
        "upload_id": req.upload_id,
        "filename": info["filename"],
        "fields": result,
    }


class SaveRequest(BaseModel):
    upload_id: str
    fields: dict


@app.post("/save")
async def save_scan(req: SaveRequest):
    filename = "unknown.pdf"
    if req.upload_id in uploads:
        filename = uploads[req.upload_id]["filename"]

    out_path = scanner.save_scan(filename, req.fields)

    return {
        "saved_path": out_path,
        "filename": Path(out_path).name,
    }


@app.get("/scans/{filename}")
async def download_scan(filename: str):
    path = scanner.SCANS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="application/json", filename=filename)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
