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
    "site_plan", "detail", "schedule", "notes", "project_stats", "other",
]

PRIORITY_TYPES = ["project_stats", "framing_plan", "roof_plan", "elevation", "floor_plan"]

EXTRACTION_FIELDS = {
    "square_footage": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "sqft_detail": {
        "total": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "conditioned": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "unconditioned": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "garage": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
        "floors": [],
        "structures": [],
        "line_items": []
    },
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
            "- If a page contains any of the following — 'Project Statistics', 'Area Schedule', 'Square Footage', 'Living Space', 'Livable SF', 'Conditioned Space', 'Total Conditioned', 'Total Square', 'SQFT', 'Building Area', 'Building Areas', or a table of room areas — label it project_stats. This takes priority over all other labels.\n"
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

    # First-match-wins: only keep the first project_stats page
    found_stats_page = False
    for p in sorted(pages, key=lambda x: x.get("page", 0)):
        if p.get("label") == "project_stats":
            if not found_stats_page:
                found_stats_page = True
            else:
                p["label"] = "other"

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
    "- For square_footage: This is the single most important field. Search every page — especially pages labeled project_stats, cover, or floor_plan — for any of these labels: 'Total Square Feet', 'Total Living Area', 'Livable SF', 'Conditioned Space', 'Total Conditioned Space', 'Area Schedule', 'Project Statistics', 'Square Footage', or any table of room areas.\n"
    "Priority order: (1) Use an explicitly labeled total if found. (2) If there is an area schedule or project statistics table, sum the conditioned/heated rows. (3) If neither exists, calculate from individual room dimensions on the floor plan.\n"
    "For conditioned SQFT: include all heated/livable areas (main floor, upper floors, finished basement). Exclude garage, unheated basement, porches, and decks unless explicitly labeled as conditioned.\n"
    "Always return the conditioned total as the primary square_footage value. Set confidence to 'extracted' if read directly from a label, 'inferred' if calculated.\n"
    "Do not return not_found if any room dimensions or area tables are visible — always attempt a calculation and show your math in reasoning.\n"
    "- For sqft_detail: Extract a full SQFT breakdown from any area schedule, project statistics block, or floor plan.\n"
    "  total: The total under-roof area including all structures, conditioned and unconditioned.\n"
    "  conditioned: Heated/livable area only (exclude garage, unheated spaces, porches, decks).\n"
    "  unconditioned: Garage, unheated basement, storage, shop, barn — any area that is not heated living space.\n"
    "  garage: Garage square footage specifically, if broken out.\n"
    "  floors: One entry per floor level found (e.g. Main Floor: 2,662 / Second Floor: 1,291 / Basement: 2,620). Include whether each floor is conditioned. Format: {\"label\": \"Main Floor\", \"sqft\": 2662, \"conditioned\": true}.\n"
    "  structures: If the plan shows multiple separate buildings (e.g. main house + detached garage + shop), list each as a separate structure with its label and sqft. Format: {\"label\": \"Main House\", \"sqft\": 2400}.\n"
    "  line_items: Copy every row from any area schedule or project statistics table verbatim — name and sqft value. Format: {\"name\": \"Main Floor Heated\", \"sqft\": 2372.3}. This is the raw source data.\n"
    "  If no breakdown is available, leave arrays empty and set total/conditioned/unconditioned to not_found.\n"
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

    total_pages = _get_page_count(pdf_path)

    if total_pages <= 10:
        # Small doc — scan everything
        page_numbers = list(range(1, total_pages + 1))
        for p in page_numbers:
            if p not in labels:
                labels[p] = "unknown"
    else:
        # Large doc — use priority selection, but always force pages 1 and 2
        for forced_page in [1, 2]:
            if forced_page not in page_numbers:
                page_numbers = [forced_page] + page_numbers
                labels[forced_page] = "cover"

    page_numbers = sorted(page_numbers)

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


def _get_field_value(scan_fields: dict, key: str):
    """Extract the raw value from a scan's extraction_fields."""
    field = scan_fields.get(key)
    if not field:
        return None
    val = field.get("value")
    if val is None or val == "" or val == []:
        return None
    return val


def _parse_number(val) -> float | None:
    """Try to parse a numeric value from a string or number."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        cleaned = val.replace(",", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _numeric_proximity(a: float, b: float) -> float:
    """Score = max(0, 1 - abs(a-b) / max(a, b))."""
    denom = max(a, b)
    if denom == 0:
        return 1.0
    return max(0.0, 1.0 - abs(a - b) / denom)


def _normalize_pitches(val) -> set:
    """Normalize roof_pitch values to a set of strings."""
    if isinstance(val, list):
        return {str(v).strip().lower() for v in val if v}
    if isinstance(val, str):
        return {val.strip().lower()}
    return set()


def _parse_bool_ish(val) -> bool | None:
    """Parse porch_or_addition as boolean."""
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        low = val.strip().lower()
        if low in ("true", "yes", "1"):
            return True
        if low in ("false", "no", "none", "0", "n/a"):
            return False
    return None


def compute_match_score(scan_a: dict, scan_b: dict) -> dict:
    """Compare two scans and return a match score + reason string.

    scan_a and scan_b are full scan records from Supabase (with extraction_fields).
    Returns {"score": int 0-100, "reason": str}.
    """
    fields_a = scan_a.get("extraction_fields") or {}
    fields_b = scan_b.get("extraction_fields") or {}

    WEIGHTS = {
        "square_footage": 0.30,
        "stories": 0.15,
        "roof_pitch": 0.15,
        "truss_type": 0.15,
        "ridge_count": 0.10,
        "valley_count": 0.10,
        "porch_or_addition": 0.05,
    }

    scores = {}
    reasons = []
    total_weight = 0.0

    # square_footage — prefer sqft_detail.conditioned if available
    def _preferred_sf(fields):
        detail = fields.get("sqft_detail") or {}
        cond = detail.get("conditioned") or {}
        cond_val = cond.get("value") if isinstance(cond, dict) else None
        if cond_val is not None:
            return _parse_number(cond_val)
        return _parse_number(_get_field_value(fields, "square_footage"))

    sf_a = _preferred_sf(fields_a)
    sf_b = _preferred_sf(fields_b)
    if sf_a is not None and sf_b is not None and sf_a > 0 and sf_b > 0:
        s = _numeric_proximity(sf_a, sf_b)
        scores["square_footage"] = s
        total_weight += WEIGHTS["square_footage"]
        pct_diff = abs(sf_a - sf_b) / max(sf_a, sf_b) * 100
        reasons.append(f"square footage within {pct_diff:.0f}% ({sf_a:,.0f} vs {sf_b:,.0f} sqft)")

    # stories
    st_a = _get_field_value(fields_a, "stories")
    st_b = _get_field_value(fields_b, "stories")
    if st_a is not None and st_b is not None:
        s = 1.0 if str(st_a).strip() == str(st_b).strip() else 0.0
        scores["stories"] = s
        total_weight += WEIGHTS["stories"]
        if s == 1.0:
            reasons.append(f"same stories ({st_a})")
        else:
            reasons.append(f"different stories ({st_a} vs {st_b})")

    # roof_pitch
    rp_a = _normalize_pitches(_get_field_value(fields_a, "roof_pitch"))
    rp_b = _normalize_pitches(_get_field_value(fields_b, "roof_pitch"))
    if rp_a and rp_b:
        overlap = rp_a & rp_b
        if overlap == rp_a == rp_b:
            s = 1.0
        elif overlap:
            s = 0.5
        else:
            s = 0.0
        scores["roof_pitch"] = s
        total_weight += WEIGHTS["roof_pitch"]
        if s == 1.0:
            reasons.append(f"same roof pitch ({', '.join(sorted(rp_a))})")
        elif s == 0.5:
            reasons.append(f"partial roof pitch overlap ({', '.join(sorted(rp_a))} vs {', '.join(sorted(rp_b))})")
        else:
            reasons.append(f"different roof pitch ({', '.join(sorted(rp_a))} vs {', '.join(sorted(rp_b))})")

    # truss_type
    tt_a = _get_field_value(fields_a, "truss_type")
    tt_b = _get_field_value(fields_b, "truss_type")
    if tt_a is not None and tt_b is not None:
        s = 1.0 if str(tt_a).strip().lower() == str(tt_b).strip().lower() else 0.0
        scores["truss_type"] = s
        total_weight += WEIGHTS["truss_type"]
        if s == 1.0:
            reasons.append(f"same truss type ({tt_a})")
        else:
            reasons.append(f"different truss type ({tt_a} vs {tt_b})")

    # ridge_count
    rc_a = _parse_number(_get_field_value(fields_a, "ridge_count"))
    rc_b = _parse_number(_get_field_value(fields_b, "ridge_count"))
    if rc_a is not None and rc_b is not None:
        denom = max(rc_a, rc_b, 1)
        s = max(0.0, 1.0 - abs(rc_a - rc_b) / denom)
        scores["ridge_count"] = s
        total_weight += WEIGHTS["ridge_count"]
        diff = abs(rc_a - rc_b)
        if diff == 0:
            reasons.append(f"same ridge count ({int(rc_a)})")
        else:
            reasons.append(f"{int(diff)} {'fewer' if rc_a < rc_b else 'more'} ridges ({int(rc_a)} vs {int(rc_b)})")

    # valley_count
    vc_a = _parse_number(_get_field_value(fields_a, "valley_count"))
    vc_b = _parse_number(_get_field_value(fields_b, "valley_count"))
    if vc_a is not None and vc_b is not None:
        denom = max(vc_a, vc_b, 1)
        s = max(0.0, 1.0 - abs(vc_a - vc_b) / denom)
        scores["valley_count"] = s
        total_weight += WEIGHTS["valley_count"]
        diff = abs(vc_a - vc_b)
        if diff == 0:
            reasons.append(f"same valley count ({int(vc_a)})")
        else:
            reasons.append(f"{int(diff)} {'fewer' if vc_a < vc_b else 'more'} valleys ({int(vc_a)} vs {int(vc_b)})")

    # porch_or_addition
    pa_a = _parse_bool_ish(_get_field_value(fields_a, "porch_or_addition"))
    pa_b = _parse_bool_ish(_get_field_value(fields_b, "porch_or_addition"))
    if pa_a is not None and pa_b is not None:
        s = 1.0 if pa_a == pa_b else 0.0
        scores["porch_or_addition"] = s
        total_weight += WEIGHTS["porch_or_addition"]
        if s == 1.0:
            reasons.append(f"both {'have' if pa_a else 'lack'} porch/addition")
        else:
            reasons.append("different porch/addition")

    # Compute final score
    if total_weight == 0:
        return {"score": 0, "reason": "No comparable fields between scans"}

    weighted_sum = sum(scores[k] * WEIGHTS[k] for k in scores)
    final = weighted_sum / total_weight
    score_int = int(round(final * 100))

    bdft_b = scan_b.get("bdft")
    bdft_part = f" BDFT from this job: {bdft_b}" if bdft_b is not None else ""
    reason = f"{score_int}% match — {', '.join(reasons)}.{bdft_part}"

    return {"score": score_int, "reason": reason}


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
