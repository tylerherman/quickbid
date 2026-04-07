import { useMemo } from "react";

const TYPES = ["roof", "walls", "floors"];

function badgeColor(score) {
  if (score >= 80) return "bg-green-100 text-green-700";
  if (score >= 60) return "bg-orange-100 text-orange-700";
  return "bg-red-100 text-red-700";
}

function fv(fields, key) {
  const f = fields?.[key];
  if (!f || typeof f !== "object") return null;
  const v = f.value;
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.length ? v.join(", ") : null;
  return v;
}

function sqftDetail(fields, sub) {
  const sd = fields?.sqft_detail;
  if (!sd || typeof sd !== "object") return null;
  const leaf = sd[sub];
  if (!leaf || typeof leaf !== "object") return null;
  return leaf.value ?? null;
}

function parseNum(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/,/g, "").trim();
  const m = s.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function matchIndicator(a, b, numeric) {
  if (a === null || b === null || a === undefined || b === undefined || a === "" || b === "") {
    return { icon: "—", cls: "text-gray-300" };
  }
  if (numeric) {
    const na = parseNum(a);
    const nb = parseNum(b);
    if (na === null || nb === null) {
      return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
        ? { icon: "✅", cls: "" }
        : { icon: "🔴", cls: "" };
    }
    if (na === nb) return { icon: "✅", cls: "" };
    const denom = Math.max(Math.abs(na), Math.abs(nb));
    if (denom === 0) return { icon: "✅", cls: "" };
    const diff = Math.abs(na - nb) / denom;
    if (diff <= 0.1) return { icon: "🟡", cls: "" };
    return { icon: "🔴", cls: "" };
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
    ? { icon: "✅", cls: "" }
    : { icon: "🔴", cls: "" };
}

const FIELD_DEFS = [
  { label: "Square Footage", numeric: true, get: (f) => fv(f, "square_footage") },
  { label: "Conditioned SQFT", numeric: true, get: (f) => sqftDetail(f, "conditioned") },
  { label: "Unconditioned SQFT", numeric: true, get: (f) => sqftDetail(f, "unconditioned") },
  { label: "Span", numeric: true, get: (f) => fv(f, "overall_span") },
  { label: "Pitch", numeric: false, get: (f) => fv(f, "roof_pitch") },
  { label: "Stories", numeric: true, get: (f) => fv(f, "stories") },
  { label: "Building Type", numeric: false, get: (f) => fv(f, "building_type") },
  { label: "Wall Height", numeric: true, get: (f) => fv(f, "ceiling_height") },
  { label: "Truss Type", numeric: false, get: (f) => fv(f, "truss_type") },
  { label: "Building Dimensions", numeric: false, get: (f) => fv(f, "building_dimensions") },
  { label: "Bearing Conditions", numeric: false, get: (f) => fv(f, "bearing_conditions") },
];

export default function CompareDrawer({ open, onClose, currentFields, currentJobName, match, onUseBdft }) {
  const rows = useMemo(() => {
    if (!match) return [];
    const matched = match.extraction_fields || {};
    return FIELD_DEFS.map((fd) => {
      const a = fd.get(currentFields || {});
      const b = fd.get(matched);
      const ind = matchIndicator(a, b, fd.numeric);
      return { label: fd.label, a, b, ind };
    });
  }, [match, currentFields]);

  if (!open || !match) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute right-0 top-0 bottom-0 w-[640px] bg-white shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900">Compare Projects</h2>
              <p className="text-xs text-gray-500 mt-1 truncate">
                <span className="font-medium">{currentJobName}</span>
                <span className="mx-1 text-gray-400">vs</span>
                <span className="font-medium">{match.job_name}</span>
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="flex gap-1.5 mt-3">
            {TYPES.map((t) => (
              <span
                key={t}
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeColor(match.scores?.[t] ?? 0)}`}
              >
                <span className="capitalize">{t}</span> {match.scores?.[t] ?? 0}%
              </span>
            ))}
          </div>
        </div>

        {/* Comparison table */}
        <div className="flex-1 overflow-y-auto min-h-0 px-8 py-6">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-3 py-2 font-medium" style={{ width: 200 }}>Field</th>
                <th className="px-3 py-2 font-medium" style={{ minWidth: 80 }}>This Job</th>
                <th className="px-3 py-2 font-medium" style={{ minWidth: 80 }}>Matched</th>
                <th className="px-3 py-2 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="px-3 py-2 text-gray-700 font-medium whitespace-nowrap">{r.label}</td>
                  <td className="px-3 py-2 text-gray-900" style={{ minWidth: 80 }}>
                    {r.a ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-900" style={{ minWidth: 80 }}>
                    {r.b ?? <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center">{r.ind.icon}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 shrink-0 flex items-center justify-between">
          <div>
            {match.bdft != null ? (
              <>
                <div className="text-2xl font-bold text-gray-900 leading-tight">
                  {Number(match.bdft).toLocaleString()}
                </div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wide">BDFT</div>
              </>
            ) : (
              <span className="text-sm text-gray-400">No BDFT recorded</span>
            )}
          </div>
          <button
            disabled={match.bdft == null}
            onClick={() => {
              onUseBdft?.(match.bdft);
              onClose();
            }}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            Use This BDFT
          </button>
        </div>
      </div>
    </div>
  );
}
