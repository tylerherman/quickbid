import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import api from "../api";
import ScanOutput from "./ScanOutput";

export default function ScanDetail() {
  const { id } = useParams();
  const [scan, setScan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [editingBdft, setEditingBdft] = useState(false);
  const [bdftValue, setBdftValue] = useState("");

  useEffect(() => {
    api
      .get(`/scans/${id}`)
      .then(({ data }) => setScan(data))
      .catch(() => setError("Scan not found"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading...
      </div>
    );
  }

  if (error || !scan) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-gray-500">{error || "Scan not found"}</p>
          <Link
            to="/saved-scans"
            className="inline-block mt-4 text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Back to Saved Scans
          </Link>
        </div>
      </div>
    );
  }

  const saveBdft = async () => {
    const parsed = bdftValue !== "" ? parseFloat(bdftValue) : null;
    if (parsed === null && !scan.bdft) {
      setEditingBdft(false);
      return;
    }
    try {
      await api.patch(`/scans/${id}`, { bdft: parsed });
      setScan((prev) => ({ ...prev, bdft: parsed }));
    } catch {
      // revert on failure
      setBdftValue(scan.bdft != null ? String(scan.bdft) : "");
    }
    setEditingBdft(false);
  };

  const thumbnails = scan.thumbnail_data || [];
  const date = scan.saved_at
    ? new Date(scan.saved_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-4 border-b border-gray-200 shrink-0">
        <div className="flex items-center gap-3 mb-2">
          <Link
            to="/saved-scans"
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            &larr; Saved Scans
          </Link>
        </div>
        <h2 className="text-lg font-semibold text-gray-900">
          {scan.filename}
        </h2>
        <p className="text-xs text-gray-400 mt-0.5">{date}</p>

        {/* Thumbnails */}
        {thumbnails.length > 0 && (
          <div className="flex gap-2 overflow-x-auto mt-3 pb-1">
            {thumbnails.map((thumb, i) => (
              <div
                key={i}
                className="shrink-0 rounded overflow-hidden border border-gray-200"
              >
                <img
                  src={`data:image/jpeg;base64,${thumb}`}
                  alt={`Page ${i + 1}`}
                  className="h-16 w-auto object-contain bg-gray-50"
                />
                <div className="px-1 py-0.5 bg-white text-center">
                  <div className="text-[10px] text-gray-400">P{i + 1}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Prompt used */}
        {scan.prompt_used && (
          <div className="mt-3">
            <button
              onClick={() => setPromptExpanded(!promptExpanded)}
              className="text-xs text-gray-500 hover:text-gray-700 font-medium flex items-center gap-1"
            >
              <svg
                className={`w-3 h-3 transition-transform ${promptExpanded ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              Prompt Used
            </button>
            {promptExpanded && (
              <pre className="mt-2 bg-gray-900 text-gray-100 text-xs font-mono p-3 rounded-lg overflow-auto max-h-60 leading-relaxed">
                {scan.prompt_used}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* BDFT field */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
        <span className="text-sm font-medium text-gray-700 w-24 shrink-0">
          Actual BDFT
        </span>
        {editingBdft ? (
          <input
            type="number"
            step="0.01"
            autoFocus
            value={bdftValue}
            onChange={(e) => setBdftValue(e.target.value)}
            onBlur={saveBdft}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveBdft();
              if (e.key === "Escape") {
                setBdftValue(scan.bdft != null ? String(scan.bdft) : "");
                setEditingBdft(false);
              }
            }}
            className="w-40 border border-blue-300 rounded-md px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            placeholder="e.g. 12.50"
          />
        ) : (
          <button
            onClick={() => {
              setBdftValue(scan.bdft != null ? String(scan.bdft) : "");
              setEditingBdft(true);
            }}
            className="text-sm text-gray-600 hover:text-blue-600 hover:bg-blue-50 px-2 py-1 rounded transition-colors"
          >
            {scan.bdft != null ? scan.bdft : <span className="text-gray-400 italic">Not set</span>}
          </button>
        )}
      </div>

      {/* Extraction results (read-only) */}
      <ScanOutput
        data={{ fields: scan.extraction_fields, filename: scan.filename }}
        readOnly
      />
    </div>
  );
}
