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
  notes: "Notes",
};

const ARRAY_FIELDS = ["roof_pitch", "notes"];

export default function ScanOutput({ data, uploadId }) {
  const [fields, setFields] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);

  // Reset local state when new data arrives
  if (data?.fields && data.fields !== fields && !saving) {
    setFields(data.fields);
    setSaved(null);
    setError(null);
  }

  if (!fields) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <div className="text-center">
          <div className="text-4xl mb-3 opacity-40">&#x1F50D;</div>
          <p className="text-sm">Run a scan to see results</p>
        </div>
      </div>
    );
  }

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
        upload_id: uploadId || "",
        fields,
      });
      setSaved(result);
    } catch (err) {
      setError(err.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header + confidence bar */}
      <div className="p-4 border-b border-gray-200 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Scan Output</h2>
          {data?.filename && (
            <span className="text-xs text-gray-400">{data.filename}</span>
          )}
        </div>
        <div className="flex items-center gap-3 mb-1.5">
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
        <div className="w-full h-2 rounded-full bg-gray-100 overflow-hidden flex">
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
        <div className="flex items-center gap-4 mt-2">
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
            Extracted — Visible text in doc
          </span>
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" />
            Inferred — Value reasoned from context
          </span>
          <span className="flex items-center gap-1 text-xs text-gray-500">
            <span className="inline-block w-2 h-2 rounded-full bg-red-400" />
            Not Found — Value not determined
          </span>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="divide-y divide-gray-100">
          {Object.entries(fields).map(([key, field]) => {
            const isArray = ARRAY_FIELDS.includes(key);
            const displayValue = isArray
              ? Array.isArray(field.value)
                ? field.value.join(", ")
                : field.value || ""
              : field.value ?? "";

            return (
              <div
                key={key}
                className={`p-4 ${
                  field.confidence === "not_found" ? "bg-red-50" : ""
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-36 shrink-0">
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
                        rows={2}
                        className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
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
                        className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                        placeholder={
                          field.confidence === "not_found"
                            ? "Enter value..."
                            : ""
                        }
                      />
                    )}
                    {field.reasoning && (
                      <div className="mt-1.5">
                        <p className="text-sm text-gray-500">
                          {field.reasoning}
                        </p>
                        {field.source_page && (
                          <p className="text-sm text-gray-400 mt-0.5">
                            <span className="font-medium">Source:</span>{" "}
                            {field.source_page}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="w-24 shrink-0">
                    <select
                      value={field.confidence}
                      onChange={(e) => updateConfidence(key, e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                    >
                      <option value="extracted">Extracted</option>
                      <option value="inferred">Inferred</option>
                      <option value="not_found">Not Found</option>
                    </select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Save bar */}
      <div className="p-4 border-t border-gray-200 shrink-0">
        {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
        {saved ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-green-600 font-medium">Saved</span>
            <a
              href={`${import.meta.env.VITE_API_URL || ""}/scans/${saved.filename}`}
              download
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              Download JSON
            </a>
          </div>
        ) : (
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-2.5 rounded-lg font-medium text-white bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm"
          >
            {saving ? "Saving..." : "Save Results"}
          </button>
        )}
      </div>
    </div>
  );
}
