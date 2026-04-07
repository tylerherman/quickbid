"""Matching engine — scores a scanned job against historical saved jobs per bid type."""
from __future__ import annotations

WEIGHTS = {
    "roof": {
        "span": 0.30,
        "pitch": 0.25,
        "sqft": 0.15,
        "stories": 0.05,
        "building_type": 0.15,
        "truss_type": 0.10,
    },
    "walls": {
        "span": 0.05,
        "sqft": 0.20,
        "stories": 0.30,
        "building_type": 0.15,
        "wall_height": 0.30,
    },
    "floors": {
        "span": 0.25,
        "sqft": 0.20,
        "stories": 0.25,
        "building_type": 0.15,
        "truss_type": 0.10,
        "bearing_conditions": 0.05,
    },
}

MAX_CONFIDENCE = {
    "roof": 0.85,
    "walls": 0.95,
    "floors": 0.90,
}

NUMERIC_FIELDS = {"span", "sqft", "stories", "wall_height", "pitch"}
CATEGORICAL_FIELDS = {"building_type", "truss_type", "bearing_conditions"}


def _to_number(v):
    if v is None or v == "" or v == []:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, list):
        # e.g. roof_pitch is a list — use first numeric-ish value
        for item in v:
            n = _to_number(item)
            if n is not None:
                return n
        return None
    if isinstance(v, str):
        s = v.replace(",", "").strip()
        # Handle "6/12" pitch → 6
        if "/" in s:
            s = s.split("/")[0].strip()
        # Strip units
        for suffix in ("ft", "sf", "sqft", "'", '"', "%"):
            if s.lower().endswith(suffix):
                s = s[: -len(suffix)].strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _field_value(fields: dict, key: str):
    """Extract raw value from extraction_fields[key].value, handling nested sqft_detail."""
    if not fields:
        return None
    f = fields.get(key)
    if not isinstance(f, dict):
        return None
    return f.get("value")


def _extract_comparable(fields: dict) -> dict:
    """Pull the comparable fields (numeric/categorical) from an extraction_fields dict."""
    if not fields:
        fields = {}

    # Prefer conditioned sqft if available
    sqft = None
    sd = fields.get("sqft_detail")
    if isinstance(sd, dict):
        cond = sd.get("conditioned")
        if isinstance(cond, dict):
            sqft = _to_number(cond.get("value"))
    if sqft is None:
        sqft = _to_number(_field_value(fields, "square_footage"))

    return {
        "span": _to_number(_field_value(fields, "overall_span")),
        "pitch": _to_number(_field_value(fields, "roof_pitch")),
        "sqft": sqft,
        "stories": _to_number(_field_value(fields, "stories")),
        "wall_height": _to_number(_field_value(fields, "ceiling_height")),
        "building_type": _field_value(fields, "building_type"),
        "truss_type": _field_value(fields, "truss_type"),
        "bearing_conditions": None,  # not in current schema
    }


def _numeric_score(a: float, b: float) -> float:
    denom = max(abs(a), abs(b))
    if denom == 0:
        return 1.0
    return max(0.0, min(1.0, 1.0 - abs(a - b) / denom))


def _categorical_score(a, b) -> float:
    if a is None or b is None:
        return 0.0
    return 1.0 if str(a).strip().lower() == str(b).strip().lower() else 0.0


def _score_for_type(a: dict, b: dict, bid_type: str) -> int:
    weights = WEIGHTS[bid_type]
    total_weight = 0.0
    weighted_sum = 0.0
    for field, w in weights.items():
        va = a.get(field)
        vb = b.get(field)
        if va is None or vb is None:
            continue
        if field in NUMERIC_FIELDS:
            s = _numeric_score(float(va), float(vb))
        else:
            s = _categorical_score(va, vb)
        weighted_sum += s * w
        total_weight += w
    if total_weight == 0:
        return 0
    raw = weighted_sum / total_weight
    # Exact match always returns 100%; otherwise cap at MAX_CONFIDENCE
    if raw >= 0.9999:
        final = 1.0
    else:
        final = min(raw, MAX_CONFIDENCE[bid_type])
    return int(round(final * 100))


def match_job(current_fields: dict, saved_scans: list) -> list:
    """Score current job against all saved scans and return a sorted list."""
    a = _extract_comparable(current_fields)
    results = []
    for scan in saved_scans:
        sid = scan.get("id")
        b = _extract_comparable(scan.get("extraction_fields") or {})
        scores = {
            "roof": _score_for_type(a, b, "roof"),
            "walls": _score_for_type(a, b, "walls"),
            "floors": _score_for_type(a, b, "floors"),
        }
        results.append({
            "job_id": sid,
            "job_name": scan.get("filename") or "Untitled",
            "builder": scan.get("builder") or "",
            "job_number": scan.get("job_number") or "",
            "bdft": scan.get("bdft"),
            "scores": scores,
            "extraction_fields": scan.get("extraction_fields") or {},
        })
    results.sort(key=lambda r: r["scores"]["roof"], reverse=True)
    return results
