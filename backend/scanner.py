from __future__ import annotations

import anthropic
import base64
import gc
import io
import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path
from pdf2image import convert_from_path
from PIL import Image
import numpy as np

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
    "truss_surface_area": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "roof_volume": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "porch_or_addition": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "footprint_shape": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
    "overall_span": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
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


def crop_whitespace(img: Image.Image, padding: int = 20) -> Image.Image:
    arr = np.array(img.convert("RGB"))
    mask = (arr < 250).any(axis=2)
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        return img
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    rmin = max(0, rmin - padding)
    rmax = min(arr.shape[0], rmax + padding)
    cmin = max(0, cmin - padding)
    cmax = min(arr.shape[1], cmax + padding)
    return img.crop((cmin, rmin, cmax, rmax))


def _convert_single_page(pdf_path: str, page_num: int, dpi: int) -> Image.Image:
    """Convert a single PDF page to PIL Image."""
    pages = convert_from_path(
        pdf_path, dpi=dpi, fmt="jpeg",
        first_page=page_num, last_page=page_num,
    )
    if not pages:
        return None
    return crop_whitespace(pages[0])


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

    # Call Claude for classification (with retry on overload)
    t_api_start = time.time()
    client = anthropic.Anthropic(timeout=600.0)
    try:
        resp = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIStatusError as e:
        if e.status_code == 529:
            logger.warning("classify_pages: 529 Overloaded — retrying in 2s")
            time.sleep(2)
            resp = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=2048,
                messages=[{"role": "user", "content": content}],
            )
        else:
            raise
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

    # Build full-res images (used for both lightbox and extraction) at 300 DPI (or 150 for large files)
    t_hires = time.time()
    file_size_mb = os.path.getsize(pdf_path) / (1024 * 1024)
    fullres_dpi = 150 if file_size_mb > 5 else 300
    full_data = []
    for pn in range(1, total_pages + 1):
        img = _convert_single_page(pdf_path, pn, dpi=fullres_dpi)
        if not img:
            full_data.append("")
            continue
        b64 = _image_to_base64(img, max_width=2000, label=f"fullres_p{pn}")
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
    "Extract the following fields from these construction plan pages. For each field, provide value, "
    "confidence (extracted|inferred|unclear|not_found), reasoning (1-2 sentences), and source_page.\n\n"
    "Field guidance:\n"
    "- building_type: single_family, garage, barn, shop, duplex, multi_family, commercial, addition, or unknown. "
    "For garage/barn/shop, set room counts to 0 with confidence=extracted.\n"
    "- square_footage: MOST IMPORTANT. Search all pages for 'Total Square Feet', 'Total Living Area', 'Livable SF', "
    "'Conditioned Space', area schedules. Priority: (1) explicit labeled total, (2) sum conditioned rows from schedule, "
    "(3) calculate from floor plan dimensions. Return conditioned total. Never guess — use 'unclear' if legibility is poor.\n"
    "- sqft_detail: Full breakdown — total (all under-roof), conditioned (heated/livable only), unconditioned, garage. "
    "floors: [{\"label\": \"Main Floor\", \"sqft\": 2662, \"conditioned\": true}]. "
    "structures: [{\"label\": \"Main House\", \"sqft\": 2400}]. "
    "line_items: copy every area schedule row verbatim [{\"name\": \"...\", \"sqft\": ...}].\n"
    "- ridge_count: Count visible ridge lines on roof/framing plan. Always attempt visual count — never not_found if ridges visible.\n"
    "- valley_count: 0 is valid (confidence=extracted) if no valleys visible.\n"
    "- overhang_depth: 0 with extracted if flush fascia/no overhang. not_found only if indeterminate.\n"
    "- footprint_shape: rectangular, L-shape, T-shape, U-shape, or irregular.\n"
    "- overall_span: Widest truss span perpendicular to ridge, in feet.\n"
    "- truss_type: Set to 'none' with extracted if stick-framed. not_found only if framing system indeterminate.\n"
    "- truss_surface_area: Look for truss design drawings, elevation views, truss schedules, or specification sheets that "
    "show individual truss surface area calculations. Check title blocks, truss manufacturer specs, or material takeoff "
    "sheets for pre-calculated front face square footage values. If no total is explicitly labeled, calculate it from "
    "visible truss dimensions: identify the truss span (heel-to-heel), pitch ratio (e.g., 6/12, 8/12), and heel height "
    "from truss elevation drawings or detail sections. Calculate surface area using the truss profile geometry "
    "(span × pitch rise factor + heel adjustments). In the reasoning field, list each truss type with its span, pitch, "
    "heel height, and calculated SF. Exclude overhangs beyond heel points and filler trusses. If multiple truss types "
    "exist, calculate each separately and list individually. Sum all trusses if a project total is needed. If calculated "
    "from dimensions rather than a labeled value, set confidence to inferred. Do not return not_found if truss dimensions "
    "and pitch are visible — always attempt a calculation. Example: '20'-0\" span, 6/12 pitch, 12\" heel = 70 SF per truss.'\n"
    "- roof_volume: Look for roof framing plans, truss layout drawings, volume calculations in specification sheets, "
    "title blocks, or material takeoff summaries for pre-calculated roof volume values (typically in cubic feet). "
    "If no total is explicitly labeled, calculate it by: (1) identifying all truss types and their cross-sectional "
    "profiles from elevation views, (2) measuring truss spacing from framing plans (typically 24\" O.C.), "
    "(3) calculating volume per truss as (truss cross-sectional area × span × spacing), (4) multiplying by quantity of "
    "each truss type, (5) summing across all trusses in the project. In the reasoning field, list each truss type, "
    "quantity, dimensions, spacing, and calculated volume, then show the sum. Account for: attic space within truss "
    "profiles, gaps between trusses, overframing conditions, valley/hip intersections, stick-framed roof sections, "
    "and multi-level roof structures. Exclude: non-structural elements, overhangs beyond heel points, garage volumes "
    "unless part of conditioned space, and non-roof volumes. If multiple roof levels or wings exist, calculate each "
    "separately and sum. If calculated from dimensions rather than labeled, set confidence to inferred. Do not return "
    "not_found if truss layouts, profiles, and spacing are visible — always attempt a calculation.\n"
    "- rooms (bedrooms, bathrooms, kitchens, garages): Count all instances across floors. "
    "For total_sqft, calculate from dimensions if no labeled total — show math in reasoning.\n\n"
    "Return ONLY valid JSON matching this structure:\n"
    f"{json.dumps(EXTRACTION_FIELDS, indent=2)}\n\n"
    "roof_pitch and notes values are arrays. All other values are string, number, or null."
)


# Shorter per-field instructions used as a fallback when the page count pushes the
# request payload close to model limits. Keeping these handy as a separate dict so
# the verbose default guidance can stay intact above.
CONDENSED_FIELD_INSTRUCTIONS = {
    "truss_surface_area": (
        "Calculate truss surface area from truss drawings. Use span, pitch, and heel "
        "height if not explicitly labeled. Set confidence to inferred if calculated. "
        "Do not return not_found if dimensions are visible."
    ),
    "roof_volume": (
        "Calculate roof volume from truss layout, spacing, and cross-sectional profiles. "
        "Set confidence to inferred if calculated. Do not return not_found if truss "
        "layouts and spacing are visible."
    ),
}


def get_prompt_for_page_count(page_count: int, base_prompt: str) -> str:
    """Swap in condensed field instructions when many pages are scanned.

    For page_count > 8 the verbose truss_surface_area / roof_volume blocks are
    replaced with shorter equivalents to keep the prompt + image payload under
    the model's context budget. For smaller scans the base prompt is returned
    unchanged. Custom prompts that don't include the matching bullet markers
    are also returned unchanged.
    """
    if page_count <= 8:
        return base_prompt
    out = base_prompt
    for field, short in CONDENSED_FIELD_INSTRUCTIONS.items():
        # Match "- <field>: ..." up to the start of the next "- " bullet or the
        # closing "Return ONLY ..." section.
        pattern = re.compile(
            rf"- {re.escape(field)}:.*?(?=\n- |\nReturn ONLY)",
            re.DOTALL,
        )
        out = pattern.sub(f"- {field}: {short}", out)
    return out


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

    base_prompt = prompt_text if prompt_text else DEFAULT_EXTRACTION_PROMPT
    prompt = get_prompt_for_page_count(len(page_numbers), base_prompt)
    if prompt is not base_prompt:
        logger.info("extract_fields: using condensed prompt for %d pages", len(page_numbers))

    content = []
    content.append({"type": "text", "text": prompt})

    # Render and encode one page at a time — higher DPI for small docs, but reduce for large files to avoid OOM
    file_size_mb = os.path.getsize(pdf_path) / (1024 * 1024)
    if file_size_mb > 5:
        render_dpi = 150
    elif total_pages <= 10:
        render_dpi = 250
    else:
        render_dpi = 150
    max_w = 2000 if total_pages <= 10 else 2000
    for pn in page_numbers:
        label = labels.get(pn, "unknown")
        logger.info("extract_fields: rendering page %d at %d DPI (total_pages=%d)", pn, render_dpi, total_pages)
        img = _convert_single_page(pdf_path, pn, dpi=render_dpi)
        if not img:
            continue
        logger.info("extract_fields: page %d — dpi=%d max_w=2000 img_size=%s", pn, render_dpi, img.size)
        b64 = _image_to_base64(img, max_width=max_w, label=f"pass2_claude_p{pn}")
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
    client = anthropic.Anthropic(timeout=600.0)
    primary_model = "claude-sonnet-4-20250514"
    fallback_model = "claude-haiku-4-5-20251001"
    model_used = primary_model
    try:
        resp = client.messages.create(
            model=primary_model,
            max_tokens=8192,
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIStatusError as e:
        if e.status_code == 529:
            logger.warning("extract_fields: 529 Overloaded on %s — retrying in 2s", primary_model)
            time.sleep(2)
            try:
                resp = client.messages.create(
                    model=primary_model,
                    max_tokens=8192,
                    messages=[{"role": "user", "content": content}],
                )
            except anthropic.APIStatusError as e2:
                if e2.status_code == 529:
                    logger.warning("extract_fields: 529 again — falling back to %s", fallback_model)
                    model_used = fallback_model
                    resp = client.messages.create(
                        model=fallback_model,
                        max_tokens=8192,
                        messages=[{"role": "user", "content": content}],
                    )
                else:
                    raise
        else:
            raise
    t_api_end = time.time()
    logger.info("extract_fields: %s API call took %.1fs", model_used, t_api_end - t_api_start)

    raw = resp.content[0].text
    _save_debug_log(filename, "pass2_extract", raw)

    # Visibility into Claude's raw response in Render logs — surfaces silent
    # truncations, empty payloads, and prose-wrapped JSON before parsing.
    logger.debug(
        "extract_fields: raw response — len=%d, head=%r",
        len(raw or ""),
        (raw or "")[:200],
    )

    text = (raw or "").strip()
    if not text:
        raise ValueError(
            "Claude returned an empty response. The document may be too large "
            "or the prompt too long. Try selecting fewer pages."
        )

    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    try:
        extracted = json.loads(text)
    except json.JSONDecodeError:
        # Claude sometimes wraps the JSON in prose. Pull out the first {...} block
        # (greedy match grabs nested objects) and try again before giving up.
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                extracted = json.loads(match.group(0))
            except json.JSONDecodeError:
                raise ValueError(
                    f"Claude returned a non-JSON response. Raw response (first 500 chars): {raw[:500]}"
                )
        else:
            raise ValueError(
                f"Claude returned a non-JSON response. Raw response (first 500 chars): {raw[:500]}"
            )

    # When a custom prompt is used, return Claude's JSON as-is so that user-defined
    # fields aren't silently dropped by the EXTRACTION_FIELDS schema filter.
    is_custom_prompt = prompt_text is not None and prompt_text != DEFAULT_EXTRACTION_PROMPT
    if is_custom_prompt:
        result = extracted
    else:
        # Standard scan — merge with defaults so every schema field is present
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
