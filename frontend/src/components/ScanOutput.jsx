import { useState } from "react";
import api from "../api";
import ConfidenceBadge from "./ConfidenceBadge";

const FIELD_LABELS = {
  building_type: "Building Type",
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

const ROOM_LABELS = {
  bedrooms: "Bedrooms",
  bathrooms: "Bathrooms",
  kitchens: "Kitchens",
  garages: "Garages",
};

export default function ScanOutput({ data, uploadId, promptUsed, thumbnailData, onSaved, readOnly = false }) {
  const [fields, setFields] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [savingToDb, setSavingToDb] = useState(false);
  const [savedToDb, setSavedToDb] = useState(false);
  const [error, setError] = useState(null);
  const [bdft, setBdft] = useState("");

  // Reset local state when new data arrives
  if (data?.fields && data.fields !== fields && !saving) {
    setFields(data.fields);
    setSaved(null);
    setSavedToDb(false);
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

  const updateRoomField = (roomType, fieldName, value) => {
    setFields((prev) => ({
      ...prev,
      rooms: {
        ...prev.rooms,
        [roomType]: { ...prev.rooms[roomType], [fieldName]: value },
      },
    }));
  };

  // Confidence counting — include rooms sub-fields
  const flatEntries = Object.entries(fields)
    .filter(([k]) => k !== "rooms")
    .map(([, v]) => v);
  const rooms = fields.rooms || {};
  Object.values(rooms).forEach((r) => flatEntries.push(r));
  const total = flatEntries.length;
  const counts = { extracted: 0, inferred: 0, unclear: 0, not_found: 0 };
  flatEntries.forEach((e) => {
    if (counts[e.confidence] !== undefined) counts[e.confidence]++;
  });

  const handleSaveToDb = async () => {
    setSavingToDb(true);
    setError(null);
    try {
      await api.post("/scans/save", {
        upload_id: uploadId || "",
        prompt_used: promptUsed || "",
        extraction_fields: fields,
        thumbnail_data: thumbnailData || [],
        bdft: bdft !== "" ? parseFloat(bdft) : null,
      });
      setSavedToDb(true);
      if (onSaved) onSaved();
    } catch (err) {
      setError(err.response?.data?.detail || "Save failed");
    } finally {
      setSavingToDb(false);
    }
  };

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
          <span className="text-xs text-amber-700">
            {counts.unclear} unclear
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
          {counts.unclear > 0 && (
            <div
              className="bg-amber-400 h-full"
              style={{ width: `${(counts.unclear / total) * 100}%` }}
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
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
            Unclear — Ambiguous or partially visible
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
          {Object.entries(fields)
            .filter(([key]) => key !== "rooms")
            .map(([key, field]) => {
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
                        <option value="unclear">Unclear</option>
                        <option value="not_found">Not Found</option>
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}

          {/* Rooms grouped card */}
          {fields.rooms && (
            <div className="p-4">
              <label className="text-sm font-semibold text-gray-900 mb-3 block">
                Rooms
              </label>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                {Object.entries(fields.rooms).map(([roomType, room]) => (
                  <div
                    key={roomType}
                    className={`p-3 ${
                      room.confidence === "not_found" ? "bg-red-50" : ""
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-28 shrink-0">
                        <label className="text-sm font-medium text-gray-700">
                          {ROOM_LABELS[roomType] || roomType}
                        </label>
                        <div className="mt-1">
                          <ConfidenceBadge confidence={room.confidence} />
                        </div>
                      </div>
                      <div className="flex-1 flex gap-3">
                        <div className="flex-1">
                          <label className="text-[11px] text-gray-400 uppercase tracking-wide">
                            Count
                          </label>
                          <input
                            type="text"
                            value={room.count ?? ""}
                            onChange={(e) =>
                              updateRoomField(roomType, "count", e.target.value || null)
                            }
                            className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                            placeholder="-"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="text-[11px] text-gray-400 uppercase tracking-wide">
                            Total Sq Ft
                          </label>
                          <input
                            type="text"
                            value={room.total_sqft ?? ""}
                            onChange={(e) =>
                              updateRoomField(roomType, "total_sqft", e.target.value || null)
                            }
                            className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                            placeholder="-"
                          />
                        </div>
                      </div>
                      <div className="w-24 shrink-0">
                        <label className="text-[11px] text-gray-400 invisible">x</label>
                        <select
                          value={room.confidence}
                          onChange={(e) =>
                            updateRoomField(roomType, "confidence", e.target.value)
                          }
                          className="w-full text-xs border border-gray-200 rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400"
                        >
                          <option value="extracted">Extracted</option>
                          <option value="inferred">Inferred</option>
                          <option value="unclear">Unclear</option>
                          <option value="not_found">Not Found</option>
                        </select>
                      </div>
                    </div>
                    {room.reasoning && (
                      <div className="mt-1.5 ml-[7.5rem]">
                        <p className="text-sm text-gray-500">{room.reasoning}</p>
                        {room.source_page && (
                          <p className="text-sm text-gray-400 mt-0.5">
                            <span className="font-medium">Source:</span>{" "}
                            {room.source_page}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Save bar */}
      {!readOnly && (
        <div className="p-4 border-t border-gray-200 shrink-0">
          {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
          <div className="mb-3">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Actual BDFT
            </label>
            <input
              type="number"
              step="0.01"
              value={bdft}
              onChange={(e) => setBdft(e.target.value)}
              className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
              placeholder="Enter the actual board feet per thousand for this job"
            />
            <p className="text-xs text-gray-400 mt-0.5">
              Enter the actual board feet per thousand for this job
            </p>
          </div>
          <div className="flex gap-2">
            {savedToDb ? (
              <span className="flex-1 py-2.5 text-center text-sm font-medium text-green-600">
                Saved!
              </span>
            ) : (
              <button
                onClick={handleSaveToDb}
                disabled={savingToDb}
                className="flex-1 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors text-sm"
              >
                {savingToDb ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Saving...
                  </span>
                ) : "Save Results"}
              </button>
            )}
            {saved ? (
              <a
                href={`${import.meta.env.VITE_API_URL || ""}/scans/download/${saved.filename}`}
                download
                className="px-4 py-2.5 rounded-lg text-sm font-medium text-blue-600 border border-blue-200 hover:bg-blue-50 transition-colors"
              >
                Download JSON
              </a>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "..." : "Export JSON"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
