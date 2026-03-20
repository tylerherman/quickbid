import { useState, useRef } from "react";
import api from "../api";

export default function UploadZone({ onComplete }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef();

  const handleFile = (f) => {
    if (f && f.type === "application/pdf") {
      setFile(f);
      setError(null);
    } else {
      setError("Please select a PDF file");
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.post("/upload", form);
      onComplete(data);
    } catch (err) {
      const msg = err.response?.data?.detail || err.message || "Upload failed";
      console.error("Upload error:", err.response?.data || err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <div
        className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-50"
            : file
              ? "border-green-400 bg-green-50"
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
          onChange={(e) => handleFile(e.target.files[0])}
        />

        {file ? (
          <div>
            <div className="text-4xl mb-3">📄</div>
            <p className="font-medium text-gray-900">{file.name}</p>
            <p className="text-sm text-gray-500 mt-1">
              {(file.size / 1024 / 1024).toFixed(1)} MB
            </p>
            <p className="text-xs text-gray-400 mt-2">Click to change file</p>
          </div>
        ) : (
          <div>
            <div className="text-4xl mb-3">📁</div>
            <p className="font-medium text-gray-700">
              Drop a PDF here or click to browse
            </p>
            <p className="text-sm text-gray-400 mt-1">
              Construction plans only
            </p>
          </div>
        )}
      </div>

      {error && (
        <p className="text-red-600 text-sm mt-3 text-center">{error}</p>
      )}

      <button
        onClick={handleUpload}
        disabled={!file || loading}
        className="mt-6 w-full py-3 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? (
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
            Scanning pages with Claude Vision...
          </span>
        ) : (
          "Scan Pages"
        )}
      </button>
    </div>
  );
}
