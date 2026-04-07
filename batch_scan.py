#!/usr/bin/env python3
"""
batch_scan.py — Batch upload and scan PDFs using the Quick Bid Scanner API.
Usage:
  python batch_scan.py --folder ./pdfs --api https://YOUR-BACKEND.onrender.com
Tracks already-scanned files in scanned_files.txt so it only processes new ones.
"""

import argparse
import json
import os
import time
import requests
from pathlib import Path

SCANNED_LOG = "scanned_files.txt"

def load_scanned():
    if not Path(SCANNED_LOG).exists():
        return set()
    return set(Path(SCANNED_LOG).read_text().splitlines())

def log_scanned(filename):
    with open(SCANNED_LOG, "a") as f:
        f.write(filename + "\n")

def poll_job(api, job_id, timeout=300):
    start = time.time()
    while time.time() - start < timeout:
        r = requests.get(f"{api}/scan-status/{job_id}")
        r.raise_for_status()
        data = r.json()
        status = data.get("status")
        if status == "complete":
            return data.get("result")
        elif status == "error":
            raise Exception(f"Job failed: {data.get('error')}")
        print(f"  [{status}] waiting...")
        time.sleep(5)
    raise Exception("Timed out waiting for job")

def scan_pdf(api, pdf_path):
    filename = pdf_path.name
    print(f"\n→ Uploading {filename}...")
    with open(pdf_path, "rb") as f:
        r = requests.post(f"{api}/upload", files={"file": (filename, f, "application/pdf")})
    r.raise_for_status()
    upload_data = r.json()
    upload_id = upload_data["upload_id"]
    job_id = upload_data["job_id"]
    print(f"  Upload ID: {upload_id}, Job ID: {job_id}")
    print("  Pass 1: Classifying pages...")
    result = poll_job(api, job_id)
    print(f"  Classified {result['total_pages']} pages")
    print("  Pass 2: Extracting fields...")
    r = requests.post(f"{api}/scan-with-prompt", json={
        "upload_id": upload_id,
        "prompt_text": "",
    })
    r.raise_for_status()
    extract_job_id = r.json()["job_id"]
    extract_result = poll_job(api, extract_job_id, timeout=600)
    fields = extract_result.get("fields", {})
    pages_scanned = extract_result.get("pages_scanned", [])
    print(f"  Extracted {len(fields)} fields from {len(pages_scanned)} pages")
    print("  Saving to database...")
    r = requests.post(f"{api}/scans/save", json={
        "upload_id": upload_id,
        "prompt_used": "batch_default",
        "extraction_fields": fields,
        "thumbnail_data": result.get("thumbnails", []),
        "bdft": None,
    })
    r.raise_for_status()
    scan_id = r.json()["scan_id"]
    print(f"  ✓ Saved — scan_id: {scan_id}")
    return scan_id

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--folder", required=True, help="Folder containing PDFs")
    parser.add_argument("--api", required=True, help="Backend API base URL")
    args = parser.parse_args()
    folder = Path(args.folder)
    api = args.api.rstrip("/")
    pdfs = sorted(folder.glob("*.pdf"))
    if not pdfs:
        print("No PDFs found in folder.")
        return
    scanned = load_scanned()
    new_pdfs = [p for p in pdfs if p.name not in scanned]
    print(f"Found {len(pdfs)} PDFs, {len(new_pdfs)} new to scan.")
    for pdf in new_pdfs:
        try:
            scan_id = scan_pdf(api, pdf)
            log_scanned(pdf.name)
        except Exception as e:
            print(f"  ✗ Failed: {e}")
            print("  Skipping — will retry next run.")
            continue
    print("\nDone.")

if __name__ == "__main__":
    main()
