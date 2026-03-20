import { useState, useEffect } from "react";
import api from "./api";
import ScanSetup from "./components/ScanSetup";
import ScanOutput from "./components/ScanOutput";

export default function App() {
  const [uploadResult, setUploadResult] = useState(null);
  const [defaultPrompt, setDefaultPrompt] = useState("");
  const [fields, setFields] = useState([]);
  const [extractionResult, setExtractionResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState("");

  useEffect(() => {
    api.get("/default-prompt").then(({ data }) => {
      setDefaultPrompt(data.prompt);
      setFields(data.fields);
    });
  }, []);

  return (
    <div className="h-screen flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
        <h1 className="text-lg font-bold text-gray-900">Quick Bid Scanner</h1>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left column */}
        <div className="w-1/2 border-r border-gray-200 flex flex-col min-h-0">
          <ScanSetup
            uploadResult={uploadResult}
            setUploadResult={setUploadResult}
            defaultPrompt={defaultPrompt}
            fields={fields}
            scanning={scanning}
            setScanning={setScanning}
            scanStatus={scanStatus}
            setScanStatus={setScanStatus}
            onResult={setExtractionResult}
          />
        </div>

        {/* Right column */}
        <div className="w-1/2 flex flex-col min-h-0">
          <ScanOutput
            data={extractionResult}
            uploadId={uploadResult?.upload_id}
          />
        </div>
      </div>
    </div>
  );
}
