import { useState, useEffect } from "react";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import api from "./api";
import ScanSetup from "./components/ScanSetup";
import ScanOutput from "./components/ScanOutput";
import SavedScans from "./components/SavedScans";
import ScanDetail from "./components/ScanDetail";
import SimilarProjects from "./components/SimilarProjects";

export default function App() {
  const [uploadResult, setUploadResult] = useState(null);
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [promptText, setPromptText] = useState("");
  const [fields, setFields] = useState([]);
  const [extractionResult, setExtractionResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState("");
  const [savedCount, setSavedCount] = useState(0);
  const location = useLocation();

  useEffect(() => {
    api.get("/default-prompt").then(({ data }) => {
      setDefaultPrompt(data.prompt);
      setPromptText(data.prompt);
      setFields(data.fields);
    });
  }, []);

  const refreshSavedCount = () => {
    api.get("/scans").then(({ data }) => {
      setSavedCount(data.scans?.length || 0);
    }).catch(() => {});
  };

  useEffect(() => {
    refreshSavedCount();
  }, []);

  const isHome = location.pathname === "/";

  return (
    <div className="h-screen flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0 flex items-center justify-between">
        <div className="flex items-baseline">
          <Link to="/" className="text-lg font-bold text-gray-900 hover:text-gray-700">
            Quick Bid Scanner
          </Link>
          <span className="text-xs text-gray-400 ml-3">deployed Apr 7, 2026 1:15pm</span>
        </div>
        <Link
          to="/saved-scans"
          className="text-sm text-gray-600 hover:text-gray-900 font-medium"
        >
          Saved Scans ({savedCount})
        </Link>
      </header>

      <Routes>
        <Route
          path="/"
          element={
            <div className="flex flex-1 min-h-0">
              <div className="w-1/3 border-r border-gray-200 flex flex-col min-h-0">
                <ScanSetup
                  uploadResult={uploadResult}
                  setUploadResult={setUploadResult}
                  defaultPrompt={defaultPrompt}
                  promptText={promptText}
                  setPromptText={setPromptText}
                  fields={fields}
                  scanning={scanning}
                  setScanning={setScanning}
                  scanStatus={scanStatus}
                  setScanStatus={setScanStatus}
                  onResult={setExtractionResult}
                />
              </div>
              <div className="w-1/3 border-r border-gray-200 flex flex-col min-h-0">
                <ScanOutput
                  data={extractionResult}
                  uploadId={uploadResult?.upload_id}
                  promptUsed={promptText}
                  thumbnailData={uploadResult?.thumbnails || []}
                  onSaved={refreshSavedCount}
                />
              </div>
              <div className="w-1/3 flex flex-col min-h-0">
                <SimilarProjects fields={extractionResult?.fields || null} />
              </div>
            </div>
          }
        />
        <Route
          path="/saved-scans"
          element={<SavedScans onCountChange={refreshSavedCount} />}
        />
        <Route path="/saved-scans/:id" element={<ScanDetail />} />
      </Routes>
    </div>
  );
}
