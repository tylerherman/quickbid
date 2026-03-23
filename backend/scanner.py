from __future__ import annotations

import anthropic
import base64
import gc
import io
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from pdf2image import convert_from_path
from PIL import Image

import psutil

logger = logging.getLogger("uvicorn.error")

SCANS_DIR = Path(__file__).parent / "scans"
SCANS_DIR.mkdir(exist_ok=True)

PAGE_TYPES = [
    "cover", "floor_plan", "roof_plan", "elevation", "framing_plan",
    "site_plan", "detail", "schedule", "notes", "other",
]

PRIORITY_TYPES = ["framing_plan", "roof_plan", "elevation", "floor_plan"]

EXTRACTION_FIELDS = {
    "square_footage": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "building_type": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "building_dimensions": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "stories": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "roof_system_type": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "roof_pitch": {"value": [], "confidence": "not_found", "reasoning": None, "source_page": None},
    "ridge_count": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "valley_count": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "overhang_depth": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "ceiling_height": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "truss_type": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "porch_or_addition": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "notes": {"value": [], "confidence": "not_found", "reasoning": None, "source_page": None},
    "rooms": {
        "bedrooms": {"count": None, "total_sqft": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "bathrooms": {"count": None, "total_sqft": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "kitchens": {"count": None, "total_sqft": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "garages": {"count": None, "total_sqft": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    },
}


def _mem_mb() -> float:
    """Current process RSS in MB."""
    return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024


def _image_to_base64(img: Image.Image, max_width: int = 800, label: str = "") -> str:
    orig_w, orig_h = img.width, img.height
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    size_kb = len(buf.getvalue()) / 1024
    if label:
        logger.info("  %s: %dx%d -> %dx%d, %.0fKB jpeg", label, orig_w, orig_h, img.width, img.height, size_kb)
    return base64.standard_b64encode(buf.getvalue()).decode()


def _convert_single_page(pdf_path: str, page_num: int, dpi: int) -> Image.Image:
    """Convert a single PDF page to PIL Image."""
    pages = convert_from_path(
        pdf_path, dpi=dpi, fmt="jpeg",
        first_page=page_num, last_page=page_num,
    )
    return pages[0] if pages else None


def _save_debug_log(filename: str, pass_name: str, response_text: str):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = Path(filename).stem
    log_path = SCANS_DIR / f"{ts}_{stem}_{pass_name}_raw.json"
    log_path.write_text(response_text, encoding="utf-8")
    return str(log_path)


def _get_page_count(pdf_path: str) -> int:
    """Get PDF page count using a minimal render."""
    from pdf2image.pdf2image import pdfinfo_from_path
    info = pdfinfo_from_path(pdf_path)
    return info.get("Pages", 0)


def classify_pages(pdf_path: str, filename: str) -> dict:
    t0 = time.time()
    mem_start = _mem_mb()

    total_pages = _get_page_count(pdf_path)
    logger.info("classify_pages: %d pages, starting (RAM: %.0fMB)", total_pages, mem_start)

    # Build Claude content — render one page at a time at 72 DPI
    content = []
    content.append({
        "type": "text",
        "text": (
            f"I'm sending you {total_pages} pages from a construction plan PDF.\n"
            "For each page, classify it as exactly one of: "
            f"{', '.join(PAGE_TYPES)}.\n\n"
            "Important classification rules:\n"
            "- If a page contains a floor plan view of any kind — even if it also contains other views, schedules, or details — label it floor_plan. Do not label it detail if a floor plan is present.\n"
            "- If a page contains a roof framing plan or truss layout — even alongside other content — label it framing_plan.\n"
            "- Only label a page detail if it contains exclusively detail views, schedules, or notes with no plan views.\n\n"
            "Return ONLY valid JSON — an array of objects with 'page' (1-indexed) and 'label'.\n"
            "Example: [{\"page\": 1, \"label\": \"cover\"}, {\"page\": 2, \"label\": \"floor_plan\"}]"
        ),
    })

    thumb_data = []
    for pn in range(1, total_pages + 1):
        img = _convert_single_page(pdf_path, pn, dpi=72)
        if not img:
            continue

        # Base64 for Claude (small)
        b64_claude = _image_to_base64(img, max_width=300, label=f"pass1_claude_p{pn}")
        content.append({"type": "text", "text": f"--- Page {pn} ---"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64_claude},
        })

        # Base64 for frontend thumbnail strip (same size)
        b64_thumb = _image_to_base64(img, max_width=300)
        thumb_data.append(b64_thumb)

        # Free the PIL image
        del img
        gc.collect()

    t_render = time.time()
    logger.info("classify_pages: 72dpi render+encode took %.1fs (RAM: %.0fMB)", t_render - t0, _mem_mb())

    # Call Claude for classification
    t_api_start = time.time()
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2048,
        messages=[{"role": "user", "content": content}],
    )
    t_api_end = time.time()
    logger.info("classify_pages: Claude API call took %.1fs", t_api_end - t_api_start)

    raw = resp.content[0].text
    _save_debug_log(filename, "pass1_classify", raw)

    # Parse JSON from response
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    pages = json.loads(text)

    # Build lightbox images — render one page at a time at 150 DPI
    t_hires = time.time()
    full_data = []
    for pn in range(1, total_pages + 1):
        img = _convert_single_page(pdf_path, pn, dpi=150)
        if not img:
            full_data.append("")
            continue
        b64 = _image_to_base64(img, max_width=1200, label=f"lightbox_p{pn}")
        full_data.append(b64)
        del img
        gc.collect()

    logger.info("classify_pages: lightbox render took %.1fs (RAM: %.0fMB)", time.time() - t_hires, _mem_mb())

    priority_order = {t: i for i, t in enumerate(PRIORITY_TYPES)}
    for p in pages:
        p["is_priority"] = p["label"] in PRIORITY_TYPES
        p["priority_rank"] = priority_order.get(p["label"], 999)
    pages.sort(key=lambda p: p["priority_rank"])

    mem_end = _mem_mb()
    logger.info("classify_pages: total %.1fs, %d pages, RAM: %.0fMB (peak delta: +%.0fMB)",
                time.time() - t0, total_pages, mem_end, mem_end - mem_start)

    return {
        "total_pages": total_pages,
        "classifications": pages,
        "thumbnails": thumb_data,
        "full_images": full_data,
    }


DEFAULT_EXTRACTION_PROMPT = (
    "I'm sending you high-resolution construction plan pages. "
    "Extract the following fields from these pages. For each field, provide a value, "
    "a confidence level, a reasoning explanation, and the source page.\n\n"
    "Confidence levels:\n"
    "- \"extracted\": value was directly read from the plan\n"
    "- \"inferred\": value was reasoned from context\n"
    "- \"not_found\": value could not be determined\n\n"
    "For each field:\n"
    "- \"reasoning\": A 1-2 sentence plain English explanation of what you saw and why you assigned that value. "
    "Example: \"Found '1,135 sq ft' labeled as 'Total Living Area' in the building area schedule on the title sheet.\"\n"
    "- \"source_page\": The page number and label where the data was found, e.g. \"Page 1 (cover)\" or \"Page 3 (framing_plan)\". "
    "If inferred, explain which pages were used. If not found, explain what was looked for and where.\n\n"
    "Field-specific guidance:\n"
    "- For building_type: Classify the overall building type as one of: single_family, garage, barn, shop, duplex, "
    "multi_family, commercial, addition, or unknown. Look at the cover page, title block, and overall plan layout. "
    "If it is clearly a detached garage or accessory structure with no living space, use garage. "
    "If it is a barn or agricultural building, use barn. Use the overall purpose and layout to determine the type. "
    "For room fields like bedrooms, bathrooms, and kitchens — if the building type is garage, barn, shop, or similar "
    "non-residential structure, set count to 0 and confidence to extracted rather than not_found.\n"
    "- For square_footage: Look for a labeled area schedule, title block, or total square footage label on floor plan and cover pages. "
    "If no total is explicitly labeled, calculate it by adding up all individual room and area dimensions visible on the floor plan pages. "
    "List each room or area with its square footage in the reasoning field and show the sum. Sum all floors if multi-story. "
    "Do not include garage square footage unless explicitly labeled as living area. "
    "If calculated from room dimensions, set confidence to inferred. "
    "Do not return not_found if room dimensions are visible — always attempt a calculation.\n"
    "- For ridge_count: Count every visible ridge line on the roof framing or roof plan. "
    "A ridge is a horizontal peak line where two roof slopes meet. Count each distinct ridge line as 1, "
    "including main ridges and any secondary ridges from wings, additions, or offsets. "
    "If you can see ridge lines but the number is not labeled, count them visually and report that count as 'inferred'. "
    "Do not return not_found if ridge lines are visible — always attempt a visual count.\n"
    "- For valley_count: If the roof framing plan clearly shows no valleys, set value to 0 and confidence to extracted. "
    "A value of 0 is a valid finding, not a missing value.\n"
    "- For overhang_depth: If elevations clearly show no overhang or a flush fascia, set value to 0 and confidence to extracted. "
    "Only use not_found if the pages were insufficient to determine whether an overhang exists.\n"
    "- For truss_type: If the roof is clearly stick-framed with no trusses, set value to none and confidence to extracted. "
    "Only use not_found if the framing system could not be determined.\n"
    "- For rooms: The 'rooms' object contains bedrooms, bathrooms, kitchens, and garages. "
    "For each room type, count all instances across all floors. "
    "For total_sqft, first look for a labeled total. If no total is labeled, calculate it by measuring or reading "
    "the individual room dimensions visible on the floor plan and multiplying length x width for each room of that type, "
    "then summing them. Show your math in the reasoning field — list each room with its dimensions and square footage. "
    "If only some rooms have readable dimensions, sum what is available and note which are missing. "
    "If room labels are visible but no dimensions are legible at all, set total_sqft to null and explain in reasoning. "
    "Confidence: extracted if total comes directly from a label, inferred if calculated from dimensions, "
    "unclear if dimensions appear present but were not legible, not_found if that room type is not visible at all. "
    "If the building type is a garage, barn, or shop and a room type clearly does not exist in the structure, "
    "set count to 0 and confidence to extracted rather than not_found.\n\n"
    "Return ONLY valid JSON matching this exact structure:\n"
    f"{json.dumps(EXTRACTION_FIELDS, indent=2)}\n\n"
    "For roof_pitch and notes, the value should be an array. "
    "For all other fields, the value should be a string or number or null."
)


def extract_fields(pdf_path: str, filename: str, page_selections: list[dict], prompt_text: str | None = None) -> dict:
    t0 = time.time()
    mem_start = _mem_mb()
    page_numbers = [p["page"] for p in page_selections]
    labels = {p["page"]: p["label"] for p in page_selections}

    logger.info("extract_fields: %d pages, starting (RAM: %.0fMB)", len(page_numbers), mem_start)

    prompt = prompt_text if prompt_text else DEFAULT_EXTRACTION_PROMPT

    content = []
    content.append({"type": "text", "text": prompt})

    # Render and encode one page at a time at 150 DPI
    for pn in page_numbers:
        label = labels.get(pn, "unknown")
        img = _convert_single_page(pdf_path, pn, dpi=150)
        if not img:
            continue
        b64 = _image_to_base64(img, max_width=2000, label=f"pass2_claude_p{pn}")
        content.append({"type": "text", "text": f"--- Page {pn} ({label}) ---"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
        })
        del img
        gc.collect()

    t_render = time.time()
    logger.info("extract_fields: 150dpi render+encode took %.1fs (RAM: %.0fMB)", t_render - t0, _mem_mb())

    t_api_start = time.time()
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=8192,
        messages=[{"role": "user", "content": content}],
    )
    t_api_end = time.time()
    logger.info("extract_fields: Claude API call took %.1fs", t_api_end - t_api_start)

    raw = resp.content[0].text
    _save_debug_log(filename, "pass2_extract", raw)

    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    extracted = json.loads(text)

    # Merge with defaults so every field is present
    result = {}
    for key, default in EXTRACTION_FIELDS.items():
        if key in extracted:
            result[key] = extracted[key]
        else:
            result[key] = default

    mem_end = _mem_mb()
    logger.info("extract_fields: total %.1fs, %d pages, RAM: %.0fMB (peak delta: +%.0fMB)",
                time.time() - t0, len(page_numbers), mem_end, mem_end - mem_start)
    return result


def save_scan(filename: str, fields: dict) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = Path(filename).stem
    out_path = SCANS_DIR / f"{ts}_{stem}_final.json"
    data = {
        "filename": filename,
        "saved_at": datetime.now().isoformat(),
        "fields": fields,
    }
    out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return str(out_path)
