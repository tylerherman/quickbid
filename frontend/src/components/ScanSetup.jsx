import { useState, useRef, useEffect } from "react";
import api from "../api";

const LS_KEY = "quickbid_saved_prompts";

function loadSavedPrompts() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
  } catch {
    return [];
  }
}

function persistPrompts(prompts) {
  localStorage.setItem(LS_KEY, JSON.stringify(prompts));
}

export default function ScanSetup({
  uploadResult,
  setUploadResult,
  defaultPrompt,
  promptText,
  setPromptText,
  fields,
  scanning,
  setScanning,
  scanStatus,
  setScanStatus,
  onResult,
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [isOverloaded, setIsOverloaded] = useState(false);
  const [lastFailed, setLastFailed] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [savedPrompts, setSavedPrompts] = useState(loadSavedPrompts);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const inputRef = useRef();
  const dropdownRef = useRef();

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Find which saved prompt matches current editor text
  const activePrompt = savedPrompts.find((p) => p.prompt_text === promptText);

  const handleSavePrompt = () => {
    if (!saveNameInput.trim()) return;
    const newPrompt = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: saveNameInput.trim(),
      prompt_text: promptText,
      saved_at: new Date().toISOString(),
    };
    const updated = [...savedPrompts, newPrompt];
    setSavedPrompts(updated);
    persistPrompts(updated);
    setSaveNameInput("");
    setShowSaveModal(false);
  };

  const handleDeletePrompt = (id) => {
    const updated = savedPrompts.filter((p) => p.id !== id);
    setSavedPrompts(updated);
    persistPrompts(updated);
    setDeleteTarget(null);
  };

  const handleSelectPrompt = (prompt) => {
    setPromptText(prompt.prompt_text);
    setDropdownOpen(false);
  };

  const handleFile = async (file) => {
    if (!file || file.type !== "application/pdf") {
      setError("Please select a PDF file");
      return;
    }
    setUploading(true);
    setError(null);
    setIsOverloaded(false);
    setLastFailed(false);
    setScanStatus("Uploading PDF...");
    try {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post("/upload", form, {
        timeout: 300000, // 5 min for large file upload transfer
        headers: { "Content-Type": "multipart/form-data" },
      });
      const jobId = data.job_id;
      setScanStatus("Classifying pages...");

      // Poll for classification completion
      let pollCount = 0;
      while (true) {
        await new Promise((r) => setTimeout(r, 3000));
        pollCount++;
        try {
          const { data: status } = await api.get(`/scan-status/${jobId}`, {
            timeout: 15000,
          });
          if (status.status === "complete") {
            setUploadResult(status.result);
            break;
          }
          if (status.status === "error") {
            if (status.error_code === 529 || status.error === "overloaded") {
              setIsOverloaded(true);
              setError("AI capacity is limited right now. We've queued a retry...");
              setLastFailed(true);
            } else {
              setError(status.error || "Classification failed");
              setLastFailed(true);
            }
            break;
          }
          // Rotate status messages
          if (pollCount < 5) {
            setScanStatus("Classifying pages...");
          } else if (pollCount < 15) {
            setScanStatus("Extracting page details...");
          } else {
            setScanStatus("Almost done...");
          }
        } catch {
          setError("Lost connection to classification job");
          break;
        }
      }
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || "Upload failed";
      console.error("Upload error:", err.response?.data || err);
      setError(msg);
    } finally {
      setUploading(false);
      setScanStatus("");
    }
  };

  const handleRunScan = async () => {
    if (!uploadResult) return;
    setScanning(true);
    setScanStatus("Starting extraction...");
    setError(null);
    setIsOverloaded(false);
    setLastFailed(false);
    try {
      const { data } = await api.post("/scan-with-prompt", {
        upload_id: uploadResult.upload_id,
        prompt_text: promptText,
      }, { timeout: 30000 });
      const jobId = data.job_id;
      setScanStatus("Extracting fields...");

      // Poll for completion
      let extractPollCount = 0;
      const poll = async () => {
        while (true) {
          await new Promise((r) => setTimeout(r, 3000));
          extractPollCount++;
          try {
            const { data: status } = await api.get(`/scan-status/${jobId}`, {
              timeout: 15000,
            });
            if (status.status === "complete") {
              try {
                if (!status.result || !status.result.fields) {
                  throw new Error("empty");
                }
                onResult(status.result);
              } catch {
                setError("Scan failed: Server returned an empty response. The file may be too large to process.");
              }
              setScanning(false);
              setScanStatus("");
              return;
            }
            if (status.status === "error") {
              if (status.error_code === 529 || status.error === "overloaded") {
                setIsOverloaded(true);
                setError("AI capacity is limited right now. We've queued a retry...");
              } else {
                const errMsg = status.error || "Unknown error";
                setError(`Scan failed: ${errMsg}. This may be due to a large file — try a smaller file or contact support.`);
              }
              setLastFailed(true);
              setScanning(false);
              setScanStatus("");
              return;
            }
            if (status.status === "processing") {
              if (extractPollCount < 10) {
                setScanStatus("Extracting fields...");
              } else {
                setScanStatus("Almost done...");
              }
            }
          } catch (err) {
            setError("Lost connection to scan job");
            setScanning(false);
            setScanStatus("");
            return;
          }
        }
      };
      await poll();
    } catch (err) {
      console.error("Scan error:", err.response?.data || err);
      const detail = err.response?.data?.detail;
      if (detail) {
        setError(`Scan failed: ${detail}. This may be due to a large file — try a smaller file or contact support.`);
      } else {
        setError("Scan failed: Server returned an empty response. The file may be too large to process.");
      }
      setScanning(false);
      setScanStatus("");
    }
  };

  const classifications = uploadResult?.classifications || [];
  const thumbnails = uploadResult?.thumbnails || [];
  const fullImages = uploadResult?.full_images || [];

  return (
    <div className="flex flex-col h-full">
      {/* PDF upload + thumbnails */}
      <div className="p-4 border-b border-gray-200 shrink-0">
        {uploadResult ? (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-medium text-gray-900 truncate">
                {uploadResult.filename}
              </span>
              <span className="text-xs text-gray-400">
                {uploadResult.total_pages} pages
              </span>
              <button
                onClick={() => inputRef.current?.click()}
                className="ml-auto text-xs text-blue-600 hover:text-blue-800 font-medium"
              >
                Replace
              </button>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files[0]) handleFile(e.target.files[0]);
                }}
              />
            </div>

            {/* Thumbnail row */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {thumbnails.map((thumb, i) => {
                const cls = classifications.find((c) => c.page === i + 1);
                const label = cls?.label;
                const isPriority = cls?.is_priority || i === 0 || i === 1;
                return (
                  <div
                    key={i}
                    onClick={() => setLightboxIndex(i)}
                    className={`shrink-0 rounded overflow-hidden border cursor-pointer hover:opacity-80 transition-opacity ${
                      isPriority
                        ? "border-blue-400 ring-1 ring-blue-200"
                        : "border-gray-200"
                    }`}
                  >
                    <img
                      src={`data:image/jpeg;base64,${thumb}`}
                      alt={`Page ${i + 1}`}
                      className="h-20 w-auto object-contain bg-gray-50"
                    />
                    <div className="px-1 py-0.5 bg-white text-center">
                      <div className="text-[10px] text-gray-400">P{i + 1}</div>
                      {label && (
                        <div
                          className={`text-[10px] font-medium truncate ${
                            isPriority ? "text-blue-600" : "text-gray-500"
                          }`}
                        >
                          {label.replace("_", " ")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              dragOver
                ? "border-blue-500 bg-blue-50"
                : "border-gray-300 bg-white hover:border-gray-400"
            }`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFile(e.dataTransfer.files[0]);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files[0]) handleFile(e.target.files[0]);
              }}
            />
            {uploading ? (
              <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                <svg
                  className="animate-spin h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Classifying pages...
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-gray-600">
                  Drop a PDF here or click to upload
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  Construction plans
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Prompt editor */}
      <div className="flex-1 flex flex-col min-h-0 p-4">
        <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Extraction Prompt
        </label>

        {/* Saved prompts toolbar */}
        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-sm border border-gray-200 rounded-md bg-white hover:bg-gray-50 text-left"
            >
              <span className={activePrompt ? "text-gray-900" : "text-gray-400"}>
                {activePrompt ? activePrompt.name : "Select a saved prompt..."}
              </span>
              <svg className="w-4 h-4 text-gray-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {dropdownOpen && (
              <div className="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-y-auto">
                {savedPrompts.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">No saved prompts</div>
                ) : (
                  savedPrompts.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 group"
                    >
                      <button
                        onClick={() => handleSelectPrompt(p)}
                        className="flex-1 text-left text-sm text-gray-700 truncate"
                      >
                        {p.name}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(p);
                          setDropdownOpen(false);
                        }}
                        className="ml-2 p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        title="Delete prompt"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => {
              setSaveNameInput("");
              setShowSaveModal(true);
            }}
            className="px-3 py-1.5 text-sm font-medium text-blue-600 border border-blue-200 rounded-md hover:bg-blue-50 transition-colors shrink-0"
          >
            Save
          </button>
        </div>

        <textarea
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          className="flex-1 min-h-0 w-full bg-gray-900 text-gray-100 text-sm font-mono p-4 rounded-lg border border-gray-700 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent leading-relaxed"
          spellCheck={false}
        />

        {/* Output fields chips */}
        <div className="mt-3">
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Output Fields
          </label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {fields.map((f) => (
              <span
                key={f}
                className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full border border-gray-200 font-mono"
              >
                {f}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">
            Field editing coming soon
          </p>
        </div>
      </div>

      {/* Error + Run button */}
      <div className="p-4 border-t border-gray-200 shrink-0">
        {error && (
          <div className={`text-sm mb-3 rounded-lg px-3 py-2 ${
            isOverloaded
              ? "bg-amber-50 border border-amber-300 text-amber-800"
              : "bg-red-50 border border-red-200 text-red-700"
          }`}>
            <p>{error}</p>
            {lastFailed && !scanning && (
              <button
                onClick={handleRunScan}
                disabled={!uploadResult}
                className="mt-2 text-xs font-medium px-3 py-1 rounded bg-white border border-current hover:opacity-80 transition-opacity"
              >
                Retry
              </button>
            )}
          </div>
        )}
        <button
          onClick={handleRunScan}
          disabled={!uploadResult || scanning || uploading}
          className={`w-full py-3 rounded-lg font-medium text-white transition-colors ${
            lastFailed && !scanning && !uploading
              ? "bg-blue-600 hover:bg-blue-700 border-2 border-orange-400"
              : "bg-blue-600 hover:bg-blue-700 border-2 border-transparent"
          } disabled:bg-gray-300 disabled:cursor-not-allowed disabled:border-transparent`}
        >
          {scanning ? (
            <span className="flex items-center justify-center gap-2">
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              {scanStatus || "Extracting fields..."}
            </span>
          ) : uploading ? (
            <span className="flex items-center justify-center gap-2">
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Classifying pages...
            </span>
          ) : lastFailed ? (
            "Retry Scan"
          ) : (
            "Run Scan"
          )}
        </button>
      </div>

      {/* Save prompt modal */}
      {showSaveModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowSaveModal(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-5 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-3">
              Name this prompt
            </h3>
            <input
              type="text"
              value={saveNameInput}
              onChange={(e) => setSaveNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSavePrompt()}
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent mb-4"
              placeholder="e.g. Roof-focused extraction"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveModal(false)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePrompt}
                disabled={!saveNameInput.trim()}
                className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
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
              Delete &lsquo;{deleteTarget.name}&rsquo;?
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
                onClick={() => handleDeletePrompt(deleteTarget.id)}
                className="px-4 py-1.5 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox modal */}
      {lightboxIndex !== null && (fullImages[lightboxIndex] || thumbnails[lightboxIndex]) && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
          onClick={() => setLightboxIndex(null)}
        >
          <div
            className="relative bg-white rounded-lg shadow-2xl flex flex-col"
            style={{ width: "95vw", height: "95vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 shrink-0">
              <span className="text-sm font-medium text-gray-900">
                Page {lightboxIndex + 1}
                {(() => {
                  const cls = classifications.find(
                    (c) => c.page === lightboxIndex + 1
                  );
                  return cls ? ` — ${cls.label.replace("_", " ")}` : "";
                })()}
              </span>
              <button
                onClick={() => setLightboxIndex(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1"
              >
                &times;
              </button>
            </div>

            {/* Image */}
            <div className="flex-1 min-h-0 flex items-center justify-center p-1 overflow-hidden">
              <img
                src={`data:image/jpeg;base64,${fullImages[lightboxIndex] || thumbnails[lightboxIndex]}`}
                alt={`Page ${lightboxIndex + 1}`}
                className="max-w-full max-h-full object-contain"
              />
            </div>

            {/* Nav arrows */}
            {lightboxIndex > 0 && (
              <button
                onClick={() => setLightboxIndex(lightboxIndex - 1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-white/90 shadow border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-white text-lg"
              >
                &#8249;
              </button>
            )}
            {lightboxIndex < thumbnails.length - 1 && (
              <button
                onClick={() => setLightboxIndex(lightboxIndex + 1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-white/90 shadow border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-white text-lg"
              >
                &#8250;
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
