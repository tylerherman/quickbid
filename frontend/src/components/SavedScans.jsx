import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import api from "../api";

function fieldCounts(extraction_fields) {
  if (!extraction_fields) return { extracted: 0, inferred: 0, not_found: 0, total: 0 };
  const counts = { extracted: 0, inferred: 0, not_found: 0 };
  let total = 0;
  for (const [key, val] of Object.entries(extraction_fields)) {
    if (key === "rooms" && typeof val === "object" && !val.confidence) {
      for (const room of Object.values(val)) {
        if (room.confidence) {
          counts[room.confidence] = (counts[room.confidence] || 0) + 1;
          total++;
        }
      }
    } else if (val?.confidence) {
      counts[val.confidence] = (counts[val.confidence] || 0) + 1;
      total++;
    }
  }
  return { ...counts, total };
}

export default function SavedScans({ onCountChange }) {
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchScans = async () => {
    try {
      const { data } = await api.get("/scans");
      setScans(data.scans || []);
    } catch {
      setScans([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScans();
  }, []);

  const handleDelete = async (id) => {
    setDeleting(true);
    try {
      await api.delete(`/scans/${id}`);
      setScans((prev) => prev.filter((s) => s.id !== id));
      if (onCountChange) onCountChange();
    } catch {
      // ignore
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading...
      </div>
    );
  }

  if (scans.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-3 opacity-40">&#x1F4C1;</div>
          <p className="text-sm text-gray-500">
            No saved scans yet. Run a scan and save the results.
          </p>
          <Link
            to="/"
            className="inline-block mt-4 text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Go to Scanner
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Saved Scans ({scans.length})
      </h2>
      <div className="grid gap-3">
        {scans.map((scan) => {
          const c = fieldCounts(scan.extraction_fields);
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
            <div
              key={scan.id}
              className="bg-white border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-start justify-between">
                <Link
                  to={`/saved-scans/${scan.id}`}
                  className="flex-1 min-w-0"
                >
                  <h3 className="text-sm font-medium text-gray-900 truncate">
                    {scan.filename}
                  </h3>
                  <p className="text-xs text-gray-400 mt-0.5">{date}</p>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-green-700">
                      {c.extracted} extracted
                    </span>
                    <span className="text-xs text-yellow-700">
                      {c.inferred} inferred
                    </span>
                    <span className="text-xs text-red-700">
                      {c.not_found} not found
                    </span>
                  </div>
                </Link>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    setDeleteTarget(scan);
                  }}
                  className="p-1.5 text-gray-300 hover:text-red-500 transition-colors shrink-0 ml-2"
                  title="Delete scan"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-5 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              Delete &lsquo;{deleteTarget.filename}&rsquo;?
            </h3>
            <p className="text-sm text-gray-500 mb-4">
              This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteTarget.id)}
                disabled={deleting}
                className="px-4 py-1.5 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:bg-gray-300"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
