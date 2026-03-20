import { useState, useRef } from "react";
import api from "../api";

export default function ScanSetup({
  uploadResult,
  setUploadResult,
  defaultPrompt,
  fields,
  scanning,
  setScanning,
  scanStatus,
  setScanStatus,
  onResult,
}) {
  const [promptText, setPromptText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef();

  // Sync default prompt into editor once loaded
  if (!promptText && defaultPrompt) {
    setPromptText(defaultPrompt);
  }

  const handleFile = async (file) => {
    if (!file || file.type !== "application/pdf") {
      setError("Please select a PDF file");
      return;
    }
    setUploading(true);
    setError(null);
    setScanStatus("Classifying pages...");
    try {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post("/upload", form);
      setUploadResult(data);
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
    setScanStatus("Extracting fields...");
    setError(null);
    try {
      const { data } = await api.post("/scan-with-prompt", {
        upload_id: uploadResult.upload_id,
        prompt_text: promptText,
      });
      onResult(data);
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || "Scan failed";
      console.error("Scan error:", err.response?.data || err);
      setError(msg);
    } finally {
      setScanning(false);
      setScanStatus("");
    }
  };

  const classifications = uploadResult?.classifications || [];
  const thumbnails = uploadResult?.thumbnails || [];

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
                const isPriority = cls?.is_priority;
                return (
                  <div
                    key={i}
                    className={`shrink-0 rounded overflow-hidden border ${
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
          <p className="text-red-600 text-sm mb-3">{error}</p>
        )}
        <button
          onClick={handleRunScan}
          disabled={!uploadResult || scanning || uploading}
          className="w-full py-3 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
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
          ) : (
            "Run Scan"
          )}
        </button>
      </div>
    </div>
  );
}
