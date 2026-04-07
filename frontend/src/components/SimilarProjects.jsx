import { useState, useEffect, useMemo, useRef } from "react";
import api from "../api";

const TYPES = ["roof", "walls", "floors"];

function badgeColor(score) {
  if (score >= 80) return "bg-green-100 text-green-700";
  if (score >= 60) return "bg-orange-100 text-orange-700";
  return "bg-red-100 text-red-700";
}

export default function SimilarProjects({ fields, onPickBdft }) {
  const [selectedTypes, setSelectedTypes] = useState(["roof"]);
  const [matches, setMatches] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const debounceRef = useRef(null);

  // Signature of key fields used for debounced re-fetch
  const keySignature = useMemo(() => {
    if (!fields) return null;
    const get = (k) => fields[k]?.value;
    const sd = fields.sqft_detail || {};
    return JSON.stringify({
      span: get("overall_span"),
      pitch: get("roof_pitch"),
      sqft: get("square_footage"),
      cond: sd.conditioned?.value ?? null,
      stories: get("stories"),
      bt: get("building_type"),
      tt: get("truss_type"),
    });
  }, [fields]);

  useEffect(() => {
    if (!fields) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await api.post("/api/match", {
          job: { extraction_fields: fields },
        });
        setMatches(data.matches || []);
      } catch {
        setMatches([]);
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [keySignature]);

  const toggleType = (t) => {
    setSelectedTypes((prev) => {
      if (prev.includes(t)) {
        if (prev.length === 1) return prev; // at least 1
        return prev.filter((x) => x !== t);
      }
      return [...prev, t];
    });
  };

  const sorted = useMemo(() => {
    if (!matches) return [];
    const score = (m) => {
      const vals = selectedTypes.map((t) => m.scores[t] ?? 0);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    return [...matches].sort((a, b) => score(b) - score(a));
  }, [matches, selectedTypes]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-200 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Similar Projects</h2>
        <div className="flex gap-2">
          {TYPES.map((t) => {
            const active = selectedTypes.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors ${
                  active
                    ? "bg-orange-500 text-white border border-orange-500"
                    : "bg-white text-gray-600 border border-gray-300 hover:border-orange-300"
                }`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {!fields && (
          <div className="text-center text-sm text-gray-400 mt-8">
            Run a scan to see similar projects
          </div>
        )}
        {fields && loading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-3 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-2/3 mb-2" />
                <div className="h-3 bg-gray-100 rounded w-1/2 mb-3" />
                <div className="flex gap-2">
                  <div className="h-5 bg-gray-100 rounded w-14" />
                  <div className="h-5 bg-gray-100 rounded w-14" />
                  <div className="h-5 bg-gray-100 rounded w-14" />
                </div>
              </div>
            ))}
          </div>
        )}
        {fields && !loading && sorted.length === 0 && (
          <div className="text-center text-sm text-gray-400 mt-8">
            No matches found
          </div>
        )}
        {fields && !loading && sorted.length > 0 && (
          <div className="space-y-2">
            {sorted.map((m) => {
              const isSel = selectedId === m.job_id;
              return (
                <div
                  key={m.job_id}
                  onClick={() => {
                    setSelectedId(m.job_id);
                    if (onPickBdft && m.bdft != null) onPickBdft(m.bdft);
                  }}
                  className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                    isSel
                      ? "border-orange-400 bg-orange-50"
                      : "border-gray-200 hover:border-gray-300 bg-white"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-900 truncate">
                        {m.job_name}
                      </div>
                      {(m.builder || m.job_number) && (
                        <div className="text-xs text-gray-500 truncate">
                          {[m.builder, m.job_number].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                    {m.bdft != null && (
                      <div className="text-right shrink-0">
                        <div className="text-lg font-bold text-gray-900 leading-tight">
                          {Number(m.bdft).toLocaleString()}
                        </div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wide">
                          BDFT
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    {TYPES.map((t) => (
                      <span
                        key={t}
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${badgeColor(
                          m.scores[t] ?? 0
                        )}`}
                      >
                        <span className="capitalize">{t}</span> {m.scores[t] ?? 0}%
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
