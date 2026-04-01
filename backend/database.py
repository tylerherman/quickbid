import json
import os
import uuid
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_ANON_KEY", "")
BUCKET = "quickbid"


def _get_client():
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def save_scan(
    filename: str,
    prompt_used: str,
    extraction_fields: dict,
    pdf_path: str,
    thumbnail_data: list,
    bdft: float = None,
) -> str:
    client = _get_client()
    scan_id = str(uuid.uuid4())

    # Upload PDF to storage
    pdf_storage_path = f"pdfs/{scan_id}/{filename}"
    with open(pdf_path, "rb") as f:
        client.storage.from_(BUCKET).upload(
            pdf_storage_path,
            f.read(),
            {"content-type": "application/pdf"},
        )

    pdf_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{pdf_storage_path}"

    # Insert scan record
    record = {
        "id": scan_id,
        "filename": filename,
        "prompt_used": prompt_used,
        "extraction_fields": extraction_fields,
        "pdf_url": pdf_url,
        "thumbnail_data": thumbnail_data,
    }
    if bdft is not None:
        record["bdft"] = bdft
    client.table("scans").insert(record).execute()

    return scan_id


def get_all_scans() -> list:
    client = _get_client()
    result = client.table("scans").select(
        "id, filename, saved_at, extraction_fields, pdf_url, bdft"
    ).order("saved_at", desc=True).execute()
    return result.data


def get_scan(scan_id: str) -> dict:
    client = _get_client()
    result = client.table("scans").select("*").eq("id", scan_id).single().execute()
    return result.data


def update_scan(scan_id: str, updates: dict) -> dict:
    client = _get_client()
    result = client.table("scans").update(updates).eq("id", scan_id).execute()
    if not result.data:
        return None
    return result.data[0]


def delete_scan(scan_id: str) -> bool:
    client = _get_client()

    # Get scan to find PDF path
    scan = get_scan(scan_id)
    if not scan:
        return False

    # Remove PDF from storage
    if scan.get("pdf_url"):
        storage_path = scan["pdf_url"].split(f"{BUCKET}/", 1)[-1]
        try:
            client.storage.from_(BUCKET).remove([storage_path])
        except Exception:
            pass  # PDF may already be gone

    # Delete record
    client.table("scans").delete().eq("id", scan_id).execute()
    return True
