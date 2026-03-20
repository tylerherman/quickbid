import { useState } from "react";
import api from "../api";

const PAGE_TYPES = [
  "cover", "floor_plan", "roof_plan", "elevation", "framing_plan",
  "site_plan", "detail", "schedule", "notes", "other",
];

const PRIORITY_TYPES = ["framing_plan", "roof_plan", "elevation", "floor_plan"];

const PRIORITY_COLORS = {
  framing_plan: "border-red-400 bg-red-50",
  roof_plan: "border-orange-400 bg-orange-50",
  elevation: "border-yellow-400 bg-yellow-50",
  floor_plan: "border-blue-400 bg-blue-50",
};

export default function PageClassification({ data, onBack, onComplete }) {
  const [classifications, setClassifications] = useState(
    // Re-sort by page number for display
    [...data.classifications].sort((a, b) => a.page - b.page)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const updateLabel = (pageNum, label) => {
    setClassifications((prev) =>
      prev.map((c) => (c.page === pageNum ? { ...c, label } : c))
    );
  };

  const priorityPages = classifications.filter((c) =>
    PRIORITY_TYPES.includes(c.label)
  );

  const handleExtract = async () => {
    if (priorityPages.length === 0) {
      setError("No priority pages selected. Ensure at least one page is labeled as framing_plan, roof_plan, elevation, or floor_plan.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: result } = await api.post("/extract", {
        upload_id: data.upload_id,
        page_selections: priorityPages.map((p) => ({
          page: p.page,
          label: p.label,
        })),
      });
      onComplete({
        ...result,
        upload_id: data.upload_id,
      });
    } catch (err) {
      setError(err.response?.data?.detail || "Extraction failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Page Classification
          </h2>
          <p className="text-sm text-gray-500">
            {data.filename} — {data.total_pages} pages —{" "}
            {priorityPages.length} priority pages selected
          </p>
        </div>
        <button
          onClick={onBack}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Back
        </button>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-6">
        {Object.entries(PRIORITY_COLORS).map(([type, cls]) => (
          <div
            key={type}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border text-xs ${cls}`}
          >
            <span className="font-medium">{type.replace("_", " ")}</span>
            <span className="text-gray-500">priority</span>
          </div>
        ))}
      </div>

      {/* Thumbnail grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8">
        {classifications.map((c) => {
          const isPriority = PRIORITY_TYPES.includes(c.label);
          const borderClass = isPriority
            ? `border-2 ${PRIORITY_COLORS[c.label]}`
            : "border border-gray-200 bg-white";

          return (
            <div key={c.page} className={`rounded-lg overflow-hidden ${borderClass}`}>
              {data.thumbnails[c.page - 1] && (
                <img
                  src={`data:image/jpeg;base64,${data.thumbnails[c.page - 1]}`}
                  alt={`Page ${c.page}`}
                  className="w-full h-40 object-contain bg-gray-100"
                />
              )}
              <div className="p-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-500">
                    Page {c.page}
                  </span>
                  {isPriority && (
                    <span className="text-xs text-green-600 font-medium">★</span>
                  )}
                </div>
                <select
                  value={c.label}
                  onChange={(e) => updateLabel(c.page, e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  {PAGE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-red-600 text-sm mb-4">{error}</p>
      )}

      <button
        onClick={handleExtract}
        disabled={loading || priorityPages.length === 0}
        className="w-full py-3 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Extracting data from {priorityPages.length} pages...
          </span>
        ) : (
          `Extract Data from ${priorityPages.length} Priority Pages`
        )}
      </button>
    </div>
  );
}
