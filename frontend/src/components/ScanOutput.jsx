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
  truss_surface_area: "Truss Surface Area",
  roof_volume: "Roof Volume",
  porch_or_addition: "Porch / Addition",
  footprint_shape: "Footprint Shape",
  overall_span: "Overall Span",
  notes: "Notes",
};

const ROOF_FIELD_ORDER = [
  "roof_system_type",
  "roof_pitch",
  "ridge_count",
  "valley_count",
  "overhang_depth",
  "truss_type",
  "truss_surface_area",
  "roof_volume",
];
const ROOF_FIELD_SET = new Set(ROOF_FIELD_ORDER);

const formatSqft = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
  if (isNaN(n)) return String(v);
  return n.toLocaleString();
};

const ARRAY_FIELDS = ["roof_pitch", "notes"];

const ROOM_LABELS = {
  bedrooms: "Bedrooms",
  bathrooms: "Bathrooms",
  kitchens: "Kitchens",
  garages: "Garages",
};

export default function ScanOutput({ data, uploadId, promptUsed, thumbnailData, onSaved, readOnly = false, onFieldsChange, bdft: bdftProp, onBdftChange, bdftHighlight = false }) {
  const isCustomPrompt = !!data?.is_custom_prompt;
  const [fields, setFields] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [savingToDb, setSavingToDb] = useState(false);
  const [savedToDb, setSavedToDb] = useState(false);
  const [error, setError] = useState(null);
  const [bdftLocal, setBdftLocal] = useState("");
  const bdft = bdftProp !== undefined ? bdftProp : bdftLocal;
  const setBdft = (v) => {
    if (onBdftChange) onBdftChange(v);
    else setBdftLocal(v);
  };

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
    setFields((prev) => {
      const next = { ...prev, [key]: { ...prev[key], value } };
      if (onFieldsChange) onFieldsChange(next);
      return next;
    });
  };

  const updateConfidence = (key, confidence) => {
    setFields((prev) => {
      const next = { ...prev, [key]: { ...prev[key], confidence } };
      if (onFieldsChange) onFieldsChange(next);
      return next;
    });
  };

  const updateSqftDetail = (subKey, value) => {
    setFields((prev) => {
      const prevDetail = prev.sqft_detail || {};
      const prevSub = prevDetail[subKey] || { value: null, confidence: "not_found", reasoning: null, source_page: null };
      const next = {
        ...prev,
        sqft_detail: {
          ...prevDetail,
          [subKey]: { ...prevSub, value },
        },
      };
      if (onFieldsChange) onFieldsChange(next);
      return next;
    });
  };

  const updateRoomField = (roomType, fieldName, value) => {
    setFields((prev) => {
      const next = {
        ...prev,
        rooms: {
          ...prev.rooms,
          [roomType]: { ...prev.rooms[roomType], [fieldName]: value },
        },
      };
      if (onFieldsChange) onFieldsChange(next);
      return next;
    });
  };

  // Confidence counting — include rooms sub-fields. For custom prompts, count any
  // returned object that happens to carry a `confidence` field; skip everything else.
  const flatEntries = [];
  Object.entries(fields).forEach(([k, v]) => {
    if (k === "rooms") return;
    if (v && typeof v === "object" && "confidence" in v) flatEntries.push(v);
  });
  const rooms = fields.rooms || {};
  Object.values(rooms).forEach((r) => {
    if (r && typeof r === "object" && "confidence" in r) flatEntries.push(r);
  });
  const total = flatEntries.length || 1;
  const counts = { extracted: 0, inferred: 0, unclear: 0, not_found: 0 };
  flatEntries.forEach((e) => {
    if (counts[e.confidence] !== undefined) counts[e.confidence]++;
  });

  const renderFieldCard = (key, field) => {
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
            {key === "square_footage" && (
              <div className="mt-2 flex gap-2">
                <div className="flex-1">
                  <label className="text-[11px] text-gray-400 uppercase tracking-wide">
                    Conditioned
                  </label>
                  <input
                    type="text"
                    value={fields.sqft_detail?.conditioned?.value ?? ""}
                    onChange={(e) => updateSqftDetail("conditioned", e.target.value || null)}
                    className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                    placeholder="-"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-[11px] text-gray-400 uppercase tracking-wide">
                    Unconditioned
                  </label>
                  <input
                    type="text"
                    value={fields.sqft_detail?.unconditioned?.value ?? fields.sqft_detail?.garage?.value ?? ""}
                    onChange={(e) => updateSqftDetail("unconditioned", e.target.value || null)}
                    className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                    placeholder="-"
                  />
                </div>
              </div>
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
  };

  // Serialize the in-memory fields object so the JSON export mirrors the UI:
  // standard fields first, then a nested "roof" group, then rooms/sqft_detail.
  // Custom prompts wrap everything under "custom_prompt_output".
  const serializeFieldsForExport = (src, custom) => {
    if (!src) return src;
    if (custom) {
      return { custom_prompt_output: { ...src } };
    }
    const out = {};
    // Standard fields (in insertion order), excluding roof/rooms/sqft_detail
    Object.entries(src).forEach(([key, val]) => {
      if (key === "rooms" || key === "sqft_detail") return;
      if (ROOF_FIELD_SET.has(key)) return;
      out[key] = val;
    });
    // Roof group, in canonical order, only including keys that exist
    const roofGroup = {};
    ROOF_FIELD_ORDER.forEach((key) => {
      if (key in src) roofGroup[key] = src[key];
    });
    if (Object.keys(roofGroup).length > 0) {
      out.roof = roofGroup;
    }
    if ("rooms" in src) out.rooms = src.rooms;
    if ("sqft_detail" in src) out.sqft_detail = src.sqft_detail;
    return out;
  };

  const handleSaveToDb = async () => {
    setSavingToDb(true);
    setError(null);
    try {
      await api.post("/scans/save", {
        upload_id: uploadId || "",
        prompt_used: promptUsed || "",
        extraction_fields: serializeFieldsForExport(fields, isCustomPrompt),
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
        fields: serializeFieldsForExport(fields, isCustomPrompt),
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
          {!isCustomPrompt && Object.entries(fields)
            .filter(([key, field]) =>
              key !== "rooms" &&
              key !== "sqft_detail" &&
              !ROOF_FIELD_SET.has(key) &&
              field && typeof field === "object" && "confidence" in field
            )
            .map(([key, field]) => renderFieldCard(key, field))}

          {/* Roof grouped section */}
          {!isCustomPrompt && ROOF_FIELD_ORDER.some((k) => fields[k]) && (
            <div className="p-4">
              <label className="text-sm font-semibold text-gray-900 mb-3 block">
                Roof
              </label>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                {ROOF_FIELD_ORDER
                  .filter((key) =>
                    fields[key] && typeof fields[key] === "object" && "confidence" in fields[key]
                  )
                  .map((key) => renderFieldCard(key, fields[key]))}
              </div>
            </div>
          )}

          {/* Rooms grouped card */}
          {!isCustomPrompt && fields.rooms && (
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

          {/* Custom Prompt Output — shown when scan used a non-default prompt */}
          {isCustomPrompt && (
            <div className="p-4">
              <label className="text-sm font-semibold text-gray-900 mb-1 block">
                Custom Prompt Output
              </label>
              <p className="text-xs text-gray-400 mb-3">
                Raw fields returned by your custom extraction prompt.
              </p>
              <div className="border border-gray-200 rounded-lg divide-y divide-gray-100 overflow-hidden">
                {Object.entries(fields).map(([key, val]) => {
                  const isObj = val && typeof val === "object" && !Array.isArray(val);
                  const hasField = isObj && "value" in val;
                  const displayValue = hasField
                    ? (Array.isArray(val.value) ? val.value.join(", ") : (val.value ?? ""))
                    : Array.isArray(val)
                      ? val.join(", ")
                      : isObj
                        ? JSON.stringify(val, null, 2)
                        : (val ?? "");
                  const confidence = hasField ? val.confidence : null;
                  const reasoning = hasField ? val.reasoning : null;
                  const sourcePage = hasField ? val.source_page : null;
                  const isMultiline = typeof displayValue === "string" && displayValue.includes("\n");

                  return (
                    <div
                      key={key}
                      className={`p-3 ${confidence === "not_found" ? "bg-red-50" : ""}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-36 shrink-0">
                          <label className="text-sm font-medium text-gray-700 break-words">
                            {key}
                          </label>
                          {confidence && (
                            <div className="mt-1">
                              <ConfidenceBadge confidence={confidence} />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          {isMultiline ? (
                            <pre className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-xs font-mono bg-gray-50 whitespace-pre-wrap break-words">
                              {String(displayValue)}
                            </pre>
                          ) : (
                            <input
                              type="text"
                              value={String(displayValue)}
                              readOnly
                              className="w-full border border-gray-200 rounded-md px-3 py-1.5 text-sm bg-gray-50 focus:outline-none"
                            />
                          )}
                          {reasoning && (
                            <div className="mt-1.5">
                              <p className="text-sm text-gray-500">{reasoning}</p>
                              {sourcePage && (
                                <p className="text-sm text-gray-400 mt-0.5">
                                  <span className="font-medium">Source:</span> {sourcePage}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
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
              className={`w-full border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent transition-colors ${
                bdftHighlight ? "border-yellow-400 bg-yellow-100" : "border-gray-200"
              }`}
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
