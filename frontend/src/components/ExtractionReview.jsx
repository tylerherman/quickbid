import { useState } from "react";
import api from "../api";
import ConfidenceBadge from "./ConfidenceBadge";

const FIELD_LABELS = {
  square_footage: "Square Footage",
  building_dimensions: "Building Dimensions",
  stories: "Stories",
  roof_system_type: "Roof System Type",
  roof_pitch: "Roof Pitch",
  ridge_count: "Ridge Count",
  valley_count: "Valley Count",
  overhang_depth: "Overhang Depth",
  ceiling_height: "Ceiling Height",
  truss_type: "Truss Type",
  porch_or_addition: "Porch / Addition",
  footprint_shape: "Footprint Shape",
  overall_span: "Overall Span",
  notes: "Notes",
};

const ARRAY_FIELDS = ["roof_pitch", "notes"];

export default function ExtractionReview({ data, onBack, onStartOver }) {
  const [fields, setFields] = useState(data.fields);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);

  const updateValue = (key, value) => {
    setFields((prev) => ({
      ...prev,
      [key]: { ...prev[key], value },
    }));
  };

  const updateConfidence = (key, confidence) => {
    setFields((prev) => ({
      ...prev,
      [key]: { ...prev[key], confidence },
    }));
  };

  // Confidence summary
  const entries = Object.values(fields);
  const total = entries.length;
  const counts = { extracted: 0, inferred: 0, not_found: 0 };
  entries.forEach((e) => {
    if (counts[e.confidence] !== undefined) counts[e.confidence]++;
  });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data: result } = await api.post("/save", {
        upload_id: data.upload_id,
        fields,
      });
      setSaved(result);
    } catch (err) {
      setError(err.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div className="max-w-xl mx-auto text-center py-12">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          Scan Saved
        </h2>
        <p className="text-gray-500 mb-6">{data.filename}</p>
        <a
          href={`${import.meta.env.VITE_API_URL || ""}/scans/${saved.filename}`}
          download
          className="inline-block px-6 py-2.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors"
        >
          Download JSON
        </a>
        <button
          onClick={onStartOver}
          className="block mx-auto mt-4 text-sm text-gray-500 hover:text-gray-700"
        >
          Scan another PDF
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Extraction Review
          </h2>
          <p className="text-sm text-gray-500">{data.filename}</p>
        </div>
        <button
          onClick={onBack}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Back
        </button>
      </div>

      {/* Confidence summary bar */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
        <div className="flex items-center gap-4 mb-2">
          <span className="text-sm font-medium text-gray-700">Confidence</span>
          <span className="text-xs text-green-700">
            {counts.extracted} extracted
          </span>
          <span className="text-xs text-yellow-700">
            {counts.inferred} inferred
          </span>
          <span className="text-xs text-red-700">
            {counts.not_found} not found
          </span>
        </div>
        <div className="w-full h-3 rounded-full bg-gray-100 overflow-hidden flex">
          {counts.extracted > 0 && (
            <div
              className="bg-green-400 h-full"
              style={{ width: `${(counts.extracted / total) * 100}%` }}
            />
          )}
          {counts.inferred > 0 && (
            <div
              className="bg-yellow-400 h-full"
              style={{ width: `${(counts.inferred / total) * 100}%` }}
            />
          )}
          {counts.not_found > 0 && (
            <div
              className="bg-red-400 h-full"
              style={{ width: `${(counts.not_found / total) * 100}%` }}
            />
          )}
        </div>
      </div>

      {/* Fields form */}
      <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
        {Object.entries(fields).filter(([key]) => key !== "sqft_detail" && key !== "rooms").map(([key, field]) => {
          const isArray = ARRAY_FIELDS.includes(key);
          const displayValue = isArray
            ? Array.isArray(field.value)
              ? field.value.join(", ")
              : field.value || ""
            : field.value ?? "";

          return (
            <div
              key={key}
              className={`flex items-start gap-4 p-4 ${
                field.confidence === "not_found" ? "bg-red-50" : ""
              }`}
            >
              <div className="w-44 shrink-0">
                <label className="text-sm font-medium text-gray-700">
                  {FIELD_LABELS[key] || key}
                </label>
                <div className="mt-1">
                  <ConfidenceBadge confidence={field.confidence} />
                </div>
              </div>
              <div className="flex-1">
                {key === "notes" ? (
                  <textarea
                    value={displayValue}
                    onChange={(e) => {
                      const val = e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      updateValue(key, val);
                    }}
                    rows={3}
                    className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                    placeholder="Comma-separated notes..."
                  />
                ) : (
                  <input
                    type="text"
                    value={displayValue}
                    onChange={(e) => {
                      if (isArray) {
                        const val = e.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean);
                        updateValue(key, val);
                      } else {
                        updateValue(key, e.target.value);
                      }
                    }}
                    className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                    placeholder={
                      field.confidence === "not_found"
                        ? "Enter value..."
                        : ""
                    }
                  />
                )}
                {field.reasoning && (
                  <div className="mt-1.5">
                    <p className="text-sm text-gray-500">{field.reasoning}</p>
                    {field.source_page && (
                      <p className="text-sm text-gray-400 mt-0.5">
                        <span className="font-medium">Source:</span> {field.source_page}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="w-28 shrink-0">
                <select
                  value={field.confidence}
                  onChange={(e) => updateConfidence(key, e.target.value)}
                  className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                >
                  <option value="extracted">Extracted</option>
                  <option value="inferred">Inferred</option>
                  <option value="not_found">Not Found</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-red-600 text-sm mt-4">{error}</p>}

      <button
        onClick={handleSave}
        disabled={saving}
        className="mt-6 w-full py-3 rounded-lg font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {saving ? "Saving..." : "Save Confirmed Data"}
      </button>
    </div>
  );
}
