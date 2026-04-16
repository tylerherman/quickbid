import json
import logging
import os
import shutil
import threading
import traceback
import uuid
from pathlib import Path
from typing import List, Dict, Optional

import anthropic
from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

import database
import scanner
import matcher

logger = logging.getLogger("uvicorn.error")

load_dotenv()

app = FastAPI(title="Quick Bid Scanner")

allowed_origins = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://localhost:5173,https://frontend-hbi0.onrender.com",
)
origins = [o.strip() for o in allowed_origins.split(",") if o.strip()]
logger.info("CORS allowed origins: %s", origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOADS_DIR = Path(__file__).parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

JOBS_DIR = Path(__file__).parent / "scans" / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)

# In-memory store: upload_id -> {path, filename, classifications}
uploads: Dict[str, Dict] = {}


def flatten_extraction_fields(fields: dict) -> dict:
    """Flatten the UI-grouped extraction fields back to a flat schema for storage.

    The frontend serializes roof-related fields under a nested "roof" key so the
    JSON export mirrors the UI layout. The DB schema and matching/scoring logic
    expect those keys at the top level — pull them up and drop the wrapper.
    """
    if not isinstance(fields, dict):
        return fields
    if "roof" not in fields or not isinstance(fields["roof"], dict):
        return fields
    out = {k: v for k, v in fields.items() if k != "roof"}
    for k, v in fields["roof"].items():
        out[k] = v
    return out


def _write_job(job_id: str, data: dict):
    path = JOBS_DIR / f"{job_id}.json"
    path.write_text(json.dumps(data), encoding="utf-8")


def _read_job(job_id: str) -> Optional[dict]:
    path = JOBS_DIR / f"{job_id}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


@app.get("/")
def root():
    return {"status": "ok"}


def _run_classification(job_id: str, upload_id: str, pdf_path: str, filename: str):
    """Background worker for page classification (Pass 1)."""
    _write_job(job_id, {"status": "classifying", "result": None, "error": None})
    try:
        result = scanner.classify_pages(pdf_path, filename)
        uploads[upload_id] = {
            "path": pdf_path,
            "filename": filename,
            "classifications": result["classifications"],
        }
        _write_job(job_id, {
            "status": "complete",
            "result": {
                "upload_id": upload_id,
                "filename": filename,
                **result,
            },
            "error": None,
        })
    except anthropic.APIStatusError as e:
        logger.error("Anthropic API error (classification): status=%s %s", e.status_code, e.message)
        if e.status_code == 529:
            _write_job(job_id, {"status": "error", "result": None, "error": "overloaded", "error_code": 529})
        else:
            _write_job(job_id, {"status": "error", "result": None, "error": f"Anthropic API error: {e.message}"})
    except Exception as e:
        logger.error("Classification failed: %s\n%s", e, traceback.format_exc())
        _write_job(job_id, {"status": "error", "result": None, "error": f"Classification failed: {str(e)}"})


@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are accepted")

    upload_id = uuid.uuid4().hex[:12]
    save_path = UPLOADS_DIR / f"{upload_id}.pdf"

    with open(save_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    job_id = uuid.uuid4().hex[:12]
    _write_job(job_id, {"status": "pending", "result": None, "error": None})

    thread = threading.Thread(
        target=_run_classification,
        args=(job_id, upload_id, str(save_path), file.filename),
        daemon=True,
    )
    thread.start()

    return {
        "job_id": job_id,
        "upload_id": upload_id,
        "status": "pending",
    }


class ExtractRequest(BaseModel):
    upload_id: str
    page_selections: List[Dict]


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
        logger.error("Anthropic API error: status=%s %s", e.status_code, e.message)
        if e.status_code == 529:
            raise HTTPException(529, "AI services are currently busy. Please wait a moment and try again.")
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


@app.get("/default-prompt")
def get_default_prompt():
    return {
        "prompt": scanner.DEFAULT_EXTRACTION_PROMPT,
        "fields": list(scanner.EXTRACTION_FIELDS.keys()),
    }


class ScanWithPromptRequest(BaseModel):
    upload_id: str
    prompt_text: str
    page_selections: Optional[List[Dict]] = None


def _run_extraction(job_id: str, upload_id: str, info: dict, selections: list, prompt_text: str):
    """Background worker for extraction."""
    _write_job(job_id, {"status": "processing", "result": None, "error": None})
    try:
        result = scanner.extract_fields(
            info["path"], info["filename"], selections,
            prompt_text=prompt_text,
        )
        is_custom = prompt_text is not None and prompt_text != scanner.DEFAULT_EXTRACTION_PROMPT
        _write_job(job_id, {
            "status": "complete",
            "result": {
                "upload_id": upload_id,
                "filename": info["filename"],
                "fields": result,
                "pages_scanned": selections,
                "is_custom_prompt": is_custom,
            },
            "error": None,
        })
    except anthropic.APIStatusError as e:
        logger.error("Anthropic API error (extraction): status=%s %s", e.status_code, e.message)
        if e.status_code == 529:
            _write_job(job_id, {"status": "error", "result": None, "error": "overloaded", "error_code": 529})
        else:
            _write_job(job_id, {"status": "error", "result": None, "error": f"Anthropic API error: {e.message}"})
    except Exception as e:
        logger.error("Extraction failed: %s\n%s", e, traceback.format_exc())
        _write_job(job_id, {"status": "error", "result": None, "error": f"Extraction failed: {str(e)}"})


@app.post("/scan-with-prompt")
async def scan_with_prompt(req: ScanWithPromptRequest):
    if req.upload_id not in uploads:
        raise HTTPException(404, "Upload not found")

    info = uploads[req.upload_id]

    MAX_EXTRACT_PAGES = 15

    # Use provided page_selections or build from classifications
    if req.page_selections:
        selections = req.page_selections
    else:
        from collections import defaultdict

        all_classifications = info["classifications"]
        total_pages = len(all_classifications)

        TYPE_LIMITS = {
            "project_stats": 1,
            "framing_plan": 3,
            "floor_plan": 4,
            "roof_plan": 2,
            "detail": 2,
            "elevation": 2,
        }

        by_type = defaultdict(list)
        for c in all_classifications:
            if c.get("is_priority"):
                by_type[c["label"]].append({"page": c["page"], "label": c["label"]})

        # Take initial allocation per type
        selections = []
        for page_type, limit in TYPE_LIMITS.items():
            selections.extend(by_type[page_type][:limit])

        # Fill remaining slots from whatever types have leftovers,
        # prioritizing framing_plan > roof_plan > elevation > floor_plan
        included_pages = {p["page"] for p in selections}
        leftovers = []
        for page_type, limit in TYPE_LIMITS.items():
            for p in by_type[page_type][limit:]:
                leftovers.append(p)

        priority_order = ["project_stats", "framing_plan", "floor_plan", "roof_plan", "detail", "elevation"]
        leftovers.sort(key=lambda p: (priority_order.index(p["label"]) if p["label"] in priority_order else 99, p["page"]))

        for p in leftovers:
            if len(selections) >= MAX_EXTRACT_PAGES:
                break
            if p["page"] not in included_pages:
                selections.append(p)
                included_pages.add(p["page"])

        selections.sort(key=lambda p: p["page"])

        logger.info("Extracting from %d of %d pages (priority capped at %d): %s",
                     len(selections), total_pages, MAX_EXTRACT_PAGES,
                     ", ".join(f"p{s['page']}({s['label']})" for s in selections))

    if not selections:
        raise HTTPException(400, "No priority pages found. Label at least one page as framing_plan, roof_plan, elevation, or floor_plan.")

    job_id = uuid.uuid4().hex[:12]
    _write_job(job_id, {"status": "pending", "result": None, "error": None})

    thread = threading.Thread(
        target=_run_extraction,
        args=(job_id, req.upload_id, info, selections, req.prompt_text),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "status": "pending"}


@app.get("/debug/last-raw")
async def debug_last_raw():
    scans_dir = Path(__file__).parent / "scans"
    files = sorted(scans_dir.glob("*_pass2_extract_raw.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        raise HTTPException(404, "No raw extraction files found")
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(files[0].read_text(encoding="utf-8"))


@app.get("/scan-status/{job_id}")
async def get_scan_status(job_id: str):
    job = _read_job(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return {
        "status": job["status"],
        "result": job.get("result"),
        "error": job.get("error"),
        "error_code": job.get("error_code"),
    }


@app.get("/scans/download/{filename}")
async def download_scan(filename: str):
    path = scanner.SCANS_DIR / filename
    if not path.exists():
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="application/json", filename=filename)


class SaveScanRequest(BaseModel):
    upload_id: str
    prompt_used: str
    extraction_fields: Dict
    thumbnail_data: Optional[List] = None
    bdft: Optional[float] = None


class UpdateScanRequest(BaseModel):
    bdft: Optional[float] = None
    extraction_fields: Optional[Dict] = None


@app.post("/scans/save")
async def save_scan_to_db(req: SaveScanRequest):
    if req.upload_id not in uploads:
        raise HTTPException(404, "Upload not found")

    info = uploads[req.upload_id]
    try:
        scan_id = database.save_scan(
            filename=info["filename"],
            prompt_used=req.prompt_used,
            extraction_fields=flatten_extraction_fields(req.extraction_fields),
            pdf_path=info["path"],
            thumbnail_data=req.thumbnail_data or [],
            bdft=req.bdft,
        )
    except Exception as e:
        logger.error("Save to Supabase failed: %s\n%s", e, traceback.format_exc())
        raise HTTPException(500, f"Save failed: {str(e)}")

    return {"scan_id": scan_id}


@app.get("/scans")
async def list_scans():
    try:
        scans = database.get_all_scans()
    except Exception as e:
        logger.error("Fetch scans failed: %s", e)
        raise HTTPException(500, f"Fetch failed: {str(e)}")
    return {"scans": scans}


@app.get("/scans/{scan_id}")
async def get_scan(scan_id: str):
    try:
        scan = database.get_scan(scan_id)
    except Exception as e:
        logger.error("Fetch scan failed: %s", e)
        raise HTTPException(404, "Scan not found")
    return scan


@app.get("/scans/{scan_id}/matches")
async def get_scan_matches(scan_id: str):
    try:
        target = database.get_scan(scan_id)
    except Exception as e:
        logger.error("Fetch scan for matches failed: %s", e)
        raise HTTPException(404, "Scan not found")

    try:
        all_scans = database.get_all_scans()
    except Exception as e:
        logger.error("Fetch scans for matching failed: %s", e)
        raise HTTPException(500, f"Fetch failed: {str(e)}")

    # Only compare against other scans that have bdft set
    candidates = [s for s in all_scans if s["id"] != scan_id and s.get("bdft") is not None]

    results = []
    for candidate in candidates:
        match = scanner.compute_match_score(target, candidate)
        results.append({
            "scan_id": candidate["id"],
            "filename": candidate["filename"],
            "score": match["score"],
            "reason": match["reason"],
            "bdft": candidate.get("bdft"),
            "saved_at": candidate.get("saved_at"),
        })

    results.sort(key=lambda x: x["score"], reverse=True)
    return {"matches": results[:5]}


@app.patch("/scans/{scan_id}")
async def update_scan(scan_id: str, req: UpdateScanRequest):
    updates = {}
    if req.bdft is not None:
        updates["bdft"] = req.bdft
    if req.extraction_fields is not None:
        updates["extraction_fields"] = flatten_extraction_fields(req.extraction_fields)
    if not updates:
        raise HTTPException(400, "No fields to update")
    try:
        result = database.update_scan(scan_id, updates)
    except Exception as e:
        logger.error("Update scan failed: %s", e)
        raise HTTPException(500, f"Update failed: {str(e)}")
    if not result:
        raise HTTPException(404, "Scan not found")
    return result


class MatchRequest(BaseModel):
    job: Dict


@app.post("/api/match")
async def api_match(req: MatchRequest):
    try:
        saved = database.get_all_scans()
    except Exception as e:
        logger.error("Fetch scans for /api/match failed: %s", e)
        raise HTTPException(500, f"Fetch failed: {str(e)}")
    fields = req.job.get("extraction_fields") or req.job.get("fields") or req.job
    results = matcher.match_job(fields, saved)
    return {"matches": results}


@app.delete("/scans/{scan_id}")
async def delete_scan(scan_id: str):
    try:
        deleted = database.delete_scan(scan_id)
    except Exception as e:
        logger.error("Delete scan failed: %s", e)
        raise HTTPException(500, f"Delete failed: {str(e)}")
    if not deleted:
        raise HTTPException(404, "Scan not found")
    return {"deleted": True}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
