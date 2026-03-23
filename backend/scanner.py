from __future__ import annotations

import anthropic
import base64
import io
import json
import os
from datetime import datetime
from pathlib import Path
from pdf2image import convert_from_path
from PIL import Image

SCANS_DIR = Path(__file__).parent / "scans"
SCANS_DIR.mkdir(exist_ok=True)

PAGE_TYPES = [
    "cover", "floor_plan", "roof_plan", "elevation", "framing_plan",
    "site_plan", "detail", "schedule", "notes", "other",
]

PRIORITY_TYPES = ["framing_plan", "roof_plan", "elevation", "floor_plan"]

EXTRACTION_FIELDS = {
    "square_footage": {"value": None, "confidence": "not_found", "reasoning": None, "source_page": None},
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


def _image_to_base64(img: Image.Image, max_width: int = 800) -> str:
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=75)
    return base64.standard_b64encode(buf.getvalue()).decode()


def _save_debug_log(filename: str, pass_name: str, response_text: str):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = Path(filename).stem
    log_path = SCANS_DIR / f"{ts}_{stem}_{pass_name}_raw.json"
    log_path.write_text(response_text, encoding="utf-8")
    return str(log_path)


def pdf_to_thumbnails(pdf_path: str) -> list[Image.Image]:
    return convert_from_path(pdf_path, dpi=72, fmt="jpeg")


def pdf_to_hires_pages(pdf_path: str, page_numbers: list[int]) -> list[Image.Image]:
    images = []
    for pn in page_numbers:
        pages = convert_from_path(
            pdf_path, dpi=150, fmt="jpeg",
            first_page=pn, last_page=pn,
        )
        if pages:
            images.append(pages[0])
    return images


def classify_pages(pdf_path: str, filename: str) -> dict:
    thumbnails = pdf_to_thumbnails(pdf_path)

    content = []
    content.append({
        "type": "text",
        "text": (
            f"I'm sending you {len(thumbnails)} pages from a construction plan PDF.\n"
            "For each page, classify it as exactly one of: "
            f"{', '.join(PAGE_TYPES)}.\n\n"
            "Return ONLY valid JSON — an array of objects with 'page' (1-indexed) and 'label'.\n"
            "Example: [{\"page\": 1, \"label\": \"cover\"}, {\"page\": 2, \"label\": \"floor_plan\"}]"
        ),
    })

    for i, thumb in enumerate(thumbnails):
        b64 = _image_to_base64(thumb)
        content.append({
            "type": "text",
            "text": f"--- Page {i + 1} ---",
        })
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": b64,
            },
        })

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2048,
        messages=[{"role": "user", "content": content}],
    )

    raw = resp.content[0].text
    _save_debug_log(filename, "pass1_classify", raw)

    # Parse JSON from response — handle markdown fences
    text = raw.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]  # drop opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    pages = json.loads(text)

    # Build thumbnail base64 list for frontend
    thumb_data = [_image_to_base64(t, max_width=300) for t in thumbnails]

    # Build higher-res images for lightbox viewing
    hires_pages = convert_from_path(pdf_path, dpi=150, fmt="jpeg")
    full_data = [_image_to_base64(p, max_width=1200) for p in hires_pages]

    priority_order = {t: i for i, t in enumerate(PRIORITY_TYPES)}

    for p in pages:
        p["is_priority"] = p["label"] in PRIORITY_TYPES
        p["priority_rank"] = priority_order.get(p["label"], 999)

    pages.sort(key=lambda p: p["priority_rank"])

    return {
        "total_pages": len(thumbnails),
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
    "- For ridge_count: Count every visible ridge line on the roof framing or roof plan. "
    "A ridge is a horizontal peak line where two roof slopes meet. Count each distinct ridge line as 1, "
    "including main ridges and any secondary ridges from wings, additions, or offsets. "
    "If you can see ridge lines but the number is not labeled, count them visually and report that count as 'inferred'. "
    "Do not return not_found if ridge lines are visible — always attempt a visual count.\n"
    "- For rooms: The 'rooms' object contains bedrooms, bathrooms, kitchens, and garages. "
    "For each room type, count all instances across all floors. "
    "For total_sqft, sum the square footage of all rooms of that type if dimensions are labeled. "
    "If only some rooms have dimensions, sum what is available and note which rooms are missing in reasoning. "
    "If room labels are visible but no dimensions are given, set count from the labels and total_sqft to null, "
    "with reasoning explaining that dimensions were not labeled. "
    "Confidence: 'extracted' if both count and sqft come directly from labeled dimensions, "
    "'inferred' if count is visible but sqft is calculated or estimated from dimensions, "
    "'not_found' if that room type is not visible at all.\n\n"
    "Return ONLY valid JSON matching this exact structure:\n"
    f"{json.dumps(EXTRACTION_FIELDS, indent=2)}\n\n"
    "For roof_pitch and notes, the value should be an array. "
    "For all other fields, the value should be a string or number or null."
)


def extract_fields(pdf_path: str, filename: str, page_selections: list[dict], prompt_text: str | None = None) -> dict:
    page_numbers = [p["page"] for p in page_selections]
    labels = {p["page"]: p["label"] for p in page_selections}
    hires = pdf_to_hires_pages(pdf_path, page_numbers)

    prompt = prompt_text if prompt_text else DEFAULT_EXTRACTION_PROMPT

    content = []
    content.append({
        "type": "text",
        "text": prompt,
    })

    for i, img in enumerate(hires):
        pn = page_numbers[i]
        label = labels.get(pn, "unknown")
        b64 = _image_to_base64(img, max_width=2000)
        content.append({
            "type": "text",
            "text": f"--- Page {pn} ({label}) ---",
        })
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": b64,
            },
        })

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        messages=[{"role": "user", "content": content}],
    )

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
